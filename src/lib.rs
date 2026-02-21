#![deny(clippy::all)]

use napi_derive::napi;
use napi::bindgen_prelude::*;

use std::path::Path;
use std::collections::HashMap;

use oxc_allocator::Allocator;
use oxc_parser::{Parser, ParseOptions, ParserReturn};
use oxc_span::{SourceType, GetSpan};
use oxc_ast::ast::*;
use oxc_codegen::{Codegen, CodegenOptions};

use lightningcss::stylesheet::{StyleSheet, ParserOptions, PrinterOptions, MinifyOptions};
use lightningcss::targets::{Targets, Browsers};

use parcel_sourcemap::SourceMap;

// ---------------------------------------------------------------------------
// Public types exposed to Node.js via NAPI-RS
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct ExtractedCssRule {
    pub hash: String,
    pub css: String,
    /// V3 source map JSON for the generated CSS.
    pub map: Option<String>,
}

#[napi(object)]
pub struct GlobalCssRule {
    pub hash: String,
    pub css: String,
    pub map: Option<String>,
}

#[napi(object)]
pub struct KeyframeRule {
    /// The hex suffix without "kf_"
    pub hash: String,
    /// The full animation name: "kf_<hash>"
    pub name: String,
    /// The full @keyframes block, minified
    pub css: String,
    pub map: Option<String>,
}

#[napi(object)]
pub struct TransformResult {
    pub code: String,
    pub css_rules: Vec<ExtractedCssRule>,
    pub global_css: Vec<GlobalCssRule>,
    pub keyframes: Vec<KeyframeRule>,
    /// V3 source map JSON for the transformed JS.
    pub map: Option<String>,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UNITLESS: &[&str] = &[
    "opacity",
    "z-index",
    "line-height",
    "flex",
    "flex-grow",
    "flex-shrink",
    "order",
    "font-weight",
    "tab-size",
    "orphans",
    "widows",
    "counter-increment",
    "counter-reset",
];

// ---------------------------------------------------------------------------
// camelCase → kebab-case
// ---------------------------------------------------------------------------

fn camel_to_kebab(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for ch in s.chars() {
        if ch.is_uppercase() {
            out.push('-');
            out.push(ch.to_lowercase().next().unwrap());
        } else {
            out.push(ch);
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Simple 32-bit hash (FNV-1a) of a string → 8 hex chars
// ---------------------------------------------------------------------------

fn hash_css(s: &str) -> String {
    let mut h: u32 = 0x811c9dc5;
    for byte in s.bytes() {
        h ^= byte as u32;
        h = h.wrapping_mul(0x01000193);
    }
    format!("{:08x}", h)
}

// ---------------------------------------------------------------------------
// Convert a byte offset into a 1-based (line, col) pair.
// ---------------------------------------------------------------------------

fn byte_offset_to_line_col(source: &str, offset: u32) -> (u32, u32) {
    let offset = offset as usize;
    let mut line: u32 = 1;
    let mut line_start: usize = 0;

    for (i, ch) in source.char_indices() {
        if i >= offset {
            break;
        }
        if ch == '\n' {
            line += 1;
            line_start = i + 1;
        }
    }

    let col = (offset - line_start) as u32 + 1;
    (line, col)
}

// ---------------------------------------------------------------------------
// Theme evaluation helpers
//
// A "theme value" is either a resolved string or a number. When the user
// writes `theme.colors.primary` the walker traverses the JSON tree to find
// the leaf. Arithmetic on numbers (*, +, -, /) is evaluated statically.
// ---------------------------------------------------------------------------

/// A resolved compile-time value from a theme member or arithmetic expression.
#[derive(Debug, Clone)]
enum ThemeValue {
    Str(String),
    Num(f64),
}

impl ThemeValue {
    fn to_css_value(&self, prop_name: &str) -> String {
        match self {
            ThemeValue::Str(s) => s.clone(),
            ThemeValue::Num(n) => {
                if UNITLESS.contains(&prop_name) {
                    if n.fract() == 0.0 {
                        format!("{}", *n as i64)
                    } else {
                        format!("{}", n)
                    }
                } else if *n == 0.0 {
                    "0".to_string()
                } else if n.fract() == 0.0 {
                    format!("{}px", *n as i64)
                } else {
                    format!("{}px", n)
                }
            }
        }
    }
}

/// Resolve a chain of member accesses on the theme JSON tree.
/// E.g. `theme.colors.primary` → walks ["colors"]["primary"].
fn resolve_theme_member(
    theme: &serde_json::Value,
    parts: &[&str],   // path segments after "theme"
    filename: &str,
    offset: u32,
    source: &str,
) -> Result<ThemeValue> {
    let mut cur = theme;
    for part in parts {
        match cur.get(part) {
            Some(v) => cur = v,
            None => {
                let (line, col) = byte_offset_to_line_col(source, offset);
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "{}:{}:{}: css() — theme.{} does not exist in the theme object.\n\
                         Hint: check your theme definition in vite.config.js.",
                        filename, line, col, parts.join(".")
                    ),
                ));
            }
        }
    }
    match cur {
        serde_json::Value::String(s) => Ok(ThemeValue::Str(s.clone())),
        serde_json::Value::Number(n) => Ok(ThemeValue::Num(n.as_f64().unwrap_or(0.0))),
        _ => {
            let (line, col) = byte_offset_to_line_col(source, offset);
            Err(Error::new(
                Status::InvalidArg,
                format!(
                    "{}:{}:{}: css() — theme.{} resolves to a non-scalar value (object/array). \
                     Only string and number leaf values are supported.",
                    filename, line, col, parts.join(".")
                ),
            ))
        }
    }
}

/// Collect the member chain from a MemberExpression: `theme.colors.primary`
/// → `["theme", "colors", "primary"]`. Returns None if any access is computed.
fn collect_member_chain<'a>(expr: &'a Expression) -> Option<Vec<&'a str>> {
    match expr {
        Expression::Identifier(id) => Some(vec![id.name.as_str()]),
        Expression::StaticMemberExpression(mem) => {
            let mut chain = collect_member_chain(&mem.object)?;
            chain.push(mem.property.name.as_str());
            Some(chain)
        }
        // Computed member access (theme.colors[key]) — unsupported
        Expression::ComputedMemberExpression(_) => None,
        _ => None,
    }
}

/// Evaluate an expression that may reference the theme object or be a plain
/// literal. Returns ThemeValue if it can be statically resolved, or an error.
fn eval_value_expr(
    expr: &Expression,
    theme: Option<&serde_json::Value>,
    filename: &str,
    source: &str,
) -> Result<ThemeValue> {
    match expr {
        Expression::StringLiteral(s) => Ok(ThemeValue::Str(s.value.to_string())),
        Expression::NumericLiteral(n) => Ok(ThemeValue::Num(n.value)),

        // Binary expressions: arithmetic on theme values
        Expression::BinaryExpression(bin) => {
            let left = eval_value_expr(&bin.left, theme, filename, source)?;
            let right = eval_value_expr(&bin.right, theme, filename, source)?;
            match bin.operator {
                BinaryOperator::Addition => match (&left, &right) {
                    (ThemeValue::Num(a), ThemeValue::Num(b)) => Ok(ThemeValue::Num(a + b)),
                    (ThemeValue::Str(a), ThemeValue::Str(b)) => {
                        Ok(ThemeValue::Str(format!("{}{}", a, b)))
                    }
                    (ThemeValue::Str(a), ThemeValue::Num(b)) => {
                        Ok(ThemeValue::Str(format!("{}{}", a, b)))
                    }
                    (ThemeValue::Num(a), ThemeValue::Str(b)) => {
                        Ok(ThemeValue::Str(format!("{}{}", a, b)))
                    }
                },
                BinaryOperator::Subtraction => match (&left, &right) {
                    (ThemeValue::Num(a), ThemeValue::Num(b)) => Ok(ThemeValue::Num(a - b)),
                    _ => {
                        let (line, col) = byte_offset_to_line_col(source, bin.span.start);
                        Err(Error::new(Status::InvalidArg, format!(
                            "{}:{}:{}: css() — subtraction is only supported between numbers.",
                            filename, line, col
                        )))
                    }
                },
                BinaryOperator::Multiplication => match (&left, &right) {
                    (ThemeValue::Num(a), ThemeValue::Num(b)) => Ok(ThemeValue::Num(a * b)),
                    _ => {
                        let (line, col) = byte_offset_to_line_col(source, bin.span.start);
                        Err(Error::new(Status::InvalidArg, format!(
                            "{}:{}:{}: css() — multiplication is only supported between numbers.",
                            filename, line, col
                        )))
                    }
                },
                BinaryOperator::Division => match (&left, &right) {
                    (ThemeValue::Num(a), ThemeValue::Num(b)) if *b != 0.0 => {
                        Ok(ThemeValue::Num(a / b))
                    }
                    _ => {
                        let (line, col) = byte_offset_to_line_col(source, bin.span.start);
                        Err(Error::new(Status::InvalidArg, format!(
                            "{}:{}:{}: css() — division by zero or non-numeric operand.",
                            filename, line, col
                        )))
                    }
                },
                _ => {
                    let (line, col) = byte_offset_to_line_col(source, bin.span.start);
                    Err(Error::new(Status::InvalidArg, format!(
                        "{}:{}:{}: css() — unsupported binary operator in theme expression.",
                        filename, line, col
                    )))
                }
            }
        }

        // Template literals: only static parts + theme member interpolations
        Expression::TemplateLiteral(tpl) => {
            let mut result = String::new();
            for (i, quasi) in tpl.quasis.iter().enumerate() {
                result.push_str(quasi.value.raw.as_str());
                if i < tpl.expressions.len() {
                    let val = eval_value_expr(&tpl.expressions[i], theme, filename, source)?;
                    match val {
                        ThemeValue::Str(s) => result.push_str(&s),
                        ThemeValue::Num(n) => result.push_str(&format!("{}", n)),
                    }
                }
            }
            Ok(ThemeValue::Str(result))
        }

        // Computed member access (e.g. theme.colors[dynamicKey]) — explicit error
        Expression::ComputedMemberExpression(cme) => {
            let (line, col) = byte_offset_to_line_col(source, cme.span.start);
            return Err(Error::new(Status::InvalidArg, format!(
                "{}:{}:{}: css() — computed member access (e.g. theme.colors[key]) is not                  supported. Use a static property name.\n                 Hint: extract the value to a constant or use a CSS variable.",
                filename, line, col
            )));
        }

        // Member expression: resolve against theme
        Expression::StaticMemberExpression(_) | Expression::Identifier(_) => {
            let chain = collect_member_chain(expr).ok_or_else(|| {
                let (line, col) = byte_offset_to_line_col(source, expr.span().start);
                Error::new(Status::InvalidArg, format!(
                    "{}:{}:{}: css() — computed member access (e.g. theme.colors[key]) is not \
                     supported. Use a static property name.\n\
                     Hint: extract the value to a constant or use a CSS variable.",
                    filename, line, col
                ))
            })?;

            // Check if the chain starts with "theme"
            if chain.first() == Some(&"theme") {
                let theme_obj = theme.ok_or_else(|| {
                    let (line, col) = byte_offset_to_line_col(source, expr.span().start);
                    Error::new(Status::InvalidArg, format!(
                        "{}:{}:{}: css() — 'theme' is referenced but no theme was provided to \
                         the plugin.\n\
                         Hint: add a theme to pigment({{ theme: yourTheme }}) in vite.config.js.",
                        filename, line, col
                    ))
                })?;
                let parts = &chain[1..]; // skip "theme"
                resolve_theme_member(theme_obj, parts, filename, expr.span().start, source)
            } else {
                // A plain identifier that's not "theme" — dynamic, not supported
                let (line, col) = byte_offset_to_line_col(source, expr.span().start);
                Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "{}:{}:{}: css() — only static values are supported \
                         (identifier '{}' is a runtime variable).\n\
                         Hint: extract the value to a constant or use a CSS variable.",
                        filename, line, col,
                        chain.first().unwrap_or(&"?")
                    ),
                ))
            }
        }

        other => {
            let (line, col) = byte_offset_to_line_col(source, other.span().start);
            Err(Error::new(
                Status::InvalidArg,
                format!(
                    "{}:{}:{}: css() — only static values are supported \
                     (property: dynamic expression).\n\
                     Hint: extract the value to a constant or use a CSS variable.",
                    filename, line, col
                ),
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// ObjectExpression → raw CSS string (recursive)
//
// `theme` is optional — when present, member expressions starting with
// "theme." are resolved against it. When absent, any non-literal value
// remains an error (same as before).
// ---------------------------------------------------------------------------

fn object_to_css(
    obj: &ObjectExpression,
    indent: usize,
    filename: &str,
    source: &str,
    theme: Option<&serde_json::Value>,
    // resolved keyframe names in scope: identifier name → "kf_<hash>"
    keyframe_names: &HashMap<String, String>,
) -> Result<String> {
    let pad = "  ".repeat(indent);
    let mut css = String::new();

    for prop in &obj.properties {
        match prop {
            ObjectPropertyKind::ObjectProperty(p) => {
                let key_str: String = match &p.key {
                    PropertyKey::StringLiteral(s) => s.value.to_string(),
                    PropertyKey::StaticIdentifier(id) => id.name.to_string(),
                    other => {
                        let (line, col) = byte_offset_to_line_col(source, other.span().start);
                        return Err(Error::new(
                            Status::InvalidArg,
                            format!(
                                "{}:{}:{}: css() — computed/private property keys are not \
                                 supported.\n\
                                 Hint: use a plain string or identifier as the property name.",
                                filename, line, col
                            ),
                        ));
                    }
                };

                match &p.value {
                    Expression::ObjectExpression(nested_obj) => {
                        let nested_css = object_to_css(nested_obj, indent + 1, filename, source, theme, keyframe_names)?;
                        css.push_str(&format!(
                            "{}{} {{\n{}{}}}\n",
                            pad, key_str, nested_css, pad
                        ));
                    }
                    Expression::StringLiteral(s) => {
                        let prop_name = camel_to_kebab(&key_str);
                        css.push_str(&format!("{}{}: {};\n", pad, prop_name, s.value));
                    }
                    Expression::NumericLiteral(n) => {
                        let prop_name = camel_to_kebab(&key_str);
                        if UNITLESS.contains(&prop_name.as_str()) {
                            css.push_str(&format!("{}{}: {};\n", pad, prop_name, n.value));
                        } else if n.value.fract() == 0.0 {
                            css.push_str(&format!(
                                "{}{}: {}px;\n",
                                pad, prop_name, n.value as i64
                            ));
                        } else {
                            css.push_str(&format!("{}{}: {}px;\n", pad, prop_name, n.value));
                        }
                    }
                    // Template literal: resolve keyframe references + static concatenation
                    Expression::TemplateLiteral(tpl) => {
                        let prop_name = camel_to_kebab(&key_str);
                        let mut val = String::new();
                        for (i, quasi) in tpl.quasis.iter().enumerate() {
                            val.push_str(quasi.value.raw.as_str());
                            if i < tpl.expressions.len() {
                                let interp = &tpl.expressions[i];
                                // Check if the interpolation is a known keyframe binding
                                if let Expression::Identifier(id) = interp {
                                    if let Some(kf_name) = keyframe_names.get(id.name.as_str()) {
                                        val.push_str(kf_name);
                                        continue;
                                    }
                                }
                                // Otherwise try to evaluate as a theme value
                                match eval_value_expr(interp, theme, filename, source)? {
                                    ThemeValue::Str(s) => val.push_str(&s),
                                    ThemeValue::Num(n) => val.push_str(&format!("{}", n)),
                                }
                            }
                        }
                        css.push_str(&format!("{}{}: {};\n", pad, prop_name, val));
                    }
                    other => {
                        // Always try static evaluation — handles theme members, arithmetic,
                        // template literals, and gives a "theme" error when theme is absent.
                        match eval_value_expr(other, theme, filename, source) {
                            Ok(tv) => {
                                let prop_name = camel_to_kebab(&key_str);
                                let val = tv.to_css_value(&prop_name);
                                css.push_str(&format!("{}{}: {};\n", pad, prop_name, val));
                            }
                            Err(e) => return Err(e),
                        }
                    }
                }
            }

            ObjectPropertyKind::SpreadProperty(spread) => {
                // Special case: container() spread is allowed
                if let Expression::CallExpression(call) = &spread.argument {
                    if is_container_call(call) {
                        let expanded = expand_container_call(call, filename, source)?;
                        css.push_str(&format!("{}{};\n", pad, expanded));
                        continue;
                    }
                }
                let (line, col) = byte_offset_to_line_col(source, spread.span.start);
                return Err(Error::new(
                    Status::InvalidArg,
                    format!(
                        "{}:{}:{}: css() — spread properties are not supported.\n\
                         Hint: inline the spread object's properties directly into this css() call.",
                        filename, line, col
                    ),
                ));
            }
        }
    }

    Ok(css)
}

// ---------------------------------------------------------------------------
// container() call helpers
// ---------------------------------------------------------------------------

fn is_container_call(call: &CallExpression) -> bool {
    matches!(
        &call.callee,
        Expression::Identifier(id) if id.name.as_str() == "container"
    )
}

/// Expand `container('sidebar', 'inline-size')` or `container('inline-size')`
/// into the CSS property declarations string (without the selector wrapper).
fn expand_container_call(
    call: &CallExpression,
    filename: &str,
    source: &str,
) -> Result<String> {
    let args: Vec<_> = call.arguments.iter()
        .filter_map(|a| a.as_expression())
        .collect();

    match args.len() {
        1 => {
            // container(type)
            let container_type = extract_string_arg(args[0], "container type", filename, source)?;
            Ok(format!("container-type: {}", container_type))
        }
        2 => {
            // container(name, type)
            let name = extract_string_arg(args[0], "container name", filename, source)?;
            let container_type = extract_string_arg(args[1], "container type", filename, source)?;
            Ok(format!("container-type: {};\n  container-name: {}", container_type, name))
        }
        _ => {
            let (line, col) = byte_offset_to_line_col(source, call.span.start);
            Err(Error::new(Status::InvalidArg, format!(
                "{}:{}:{}: container() — expected 1 or 2 arguments: container(type) or container(name, type).",
                filename, line, col
            )))
        }
    }
}

fn extract_string_arg<'a>(
    expr: &'a Expression<'a>,
    what: &str,
    filename: &str,
    source: &str,
) -> Result<String> {
    match expr {
        Expression::StringLiteral(s) => Ok(s.value.to_string()),
        other => {
            let (line, col) = byte_offset_to_line_col(source, other.span().start);
            Err(Error::new(Status::InvalidArg, format!(
                "{}:{}:{}: container() — {} must be a static string literal.",
                filename, line, col, what
            )))
        }
    }
}

// ---------------------------------------------------------------------------
// Process one css({}) argument → (class_name, minified_css, optional_css_map)
// ---------------------------------------------------------------------------

fn process_css_object(
    obj: &ObjectExpression,
    span_start: u32,
    filename: &str,
    source: &str,
    theme: Option<&serde_json::Value>,
    keyframe_names: &HashMap<String, String>,
    dir: &str,
) -> Result<(String, String, Option<String>)> {
    // 1. Build raw CSS using a placeholder class name
    let inner = object_to_css(obj, 1, filename, source, theme, keyframe_names)?;
    let raw_css = format!(".css_obj {{\n{}}}\n", inner);

    // 2. Hash the filename and AST node position to produce a stable, unique class name
    let hash_input = format!("{}:{}", filename, span_start);
    let hash = hash_css(&hash_input);
    let class_name = format!("cls_{}", hash);

    process_raw_css_with_placeholder(&raw_css, &class_name, ".css_obj", filename, dir)
}

/// Shared LightningCSS pipeline: parse → minify → print → replace placeholder
/// `dir` is "ltr" (default) or "rtl" — passed to LightningCSS PrinterOptions.
/// Returns (final_css, css_map_json)
fn run_lightningcss(
    raw_css: &str,
    filename: &str,
    dir: &str,
) -> Result<(String, Option<String>)> {
    // Container-query-aware browser targets (Chrome 105+, Safari 16+, Firefox 110+)
    let targets = Targets {
        browsers: Some(Browsers {
            chrome:  Some(105 << 16),
            safari:  Some(16 << 16),
            firefox: Some(110 << 16),
            ..Browsers::default()
        }),
        ..Targets::default()
    };

    let parser_options = ParserOptions::default();
    let mut stylesheet = StyleSheet::parse(raw_css, parser_options).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("{}: LightningCSS parse error: {}", filename, e),
        )
    })?;

    stylesheet.minify(MinifyOptions::default()).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("{}: LightningCSS minify error: {:?}", filename, e),
        )
    })?;

    let _ = dir; // reserved for future LightningCSS direction support
    let mut css_source_map = SourceMap::new("/");
    let printer_options = PrinterOptions {
        minify: true,
        targets,
        source_map: Some(&mut css_source_map),
        ..PrinterOptions::default()
    };

    let result = stylesheet.to_css(printer_options).map_err(|e| {
        Error::new(
            Status::GenericFailure,
            format!("{}: LightningCSS print error: {:?}", filename, e),
        )
    })?;

    let css_map_json = css_source_map
        .to_json(None)
        .ok()
        .map(|json| json.to_string());

    Ok((result.code, css_map_json))
}

fn process_raw_css_with_placeholder(
    raw_css: &str,
    final_name: &str,
    placeholder: &str,
    filename: &str,
    dir: &str,
) -> Result<(String, String, Option<String>)> {
    let (css_code, css_map) = run_lightningcss(raw_css, filename, dir)?;
    let final_css = css_code.replace(placeholder, &format!(".{}", final_name));
    Ok((final_name.to_string(), final_css, css_map))
}

// ---------------------------------------------------------------------------
// Process a globalCss tagged template literal
// ---------------------------------------------------------------------------

fn process_global_css_template(
    tpl: &TemplateLiteral,
    filename: &str,
    source: &str,
    theme: Option<&serde_json::Value>,
    dir: &str,
) -> Result<(String, String, Option<String>)> {
    // Concatenate quasis and (static) expressions
    let mut raw = String::new();
    for (i, quasi) in tpl.quasis.iter().enumerate() {
        raw.push_str(quasi.value.raw.as_str());
        if i < tpl.expressions.len() {
            let interp = &tpl.expressions[i];
            match interp {
                Expression::StringLiteral(s) => raw.push_str(&s.value),
                Expression::NumericLiteral(n) => raw.push_str(&format!("{}", n.value)),
                _ => {
                    // Try theme resolution
                    if let Some(th) = theme {
                        match eval_value_expr(interp, Some(th), filename, source) {
                            Ok(ThemeValue::Str(s)) => { raw.push_str(&s); }
                            Ok(ThemeValue::Num(n)) => { raw.push_str(&format!("{}", n)); }
                            Err(e) => return Err(e),
                        }
                    } else {
                        let (line, col) = byte_offset_to_line_col(source, interp.span().start);
                        return Err(Error::new(Status::InvalidArg, format!(
                            "{}:{}:{}: globalCss — interpolations must be static string or number \
                             values.\n\
                             Hint: extract the value to a constant or use a CSS variable.",
                            filename, line, col
                        )));
                    }
                }
            }
        }
    }

    let hash_input = format!("{}:{}", filename, tpl.span.start);
    let hash = hash_css(&hash_input);
    let (css_code, css_map) = run_lightningcss(&raw, filename, dir)?;
    Ok((hash, css_code, css_map))
}

// ---------------------------------------------------------------------------
// Process a keyframes tagged template literal
// ---------------------------------------------------------------------------

fn process_keyframes_template(
    tpl: &TemplateLiteral,
    filename: &str,
    source: &str,
    dir: &str,
) -> Result<(String, String, String, Option<String>)> {
    // Concatenate quasis and static expressions
    let mut inner = String::new();
    for (i, quasi) in tpl.quasis.iter().enumerate() {
        inner.push_str(quasi.value.raw.as_str());
        if i < tpl.expressions.len() {
            let interp = &tpl.expressions[i];
            match interp {
                Expression::StringLiteral(s) => inner.push_str(&s.value),
                Expression::NumericLiteral(n) => inner.push_str(&format!("{}", n.value)),
                other => {
                    let (line, col) = byte_offset_to_line_col(source, other.span().start);
                    return Err(Error::new(Status::InvalidArg, format!(
                        "{}:{}:{}: keyframes — interpolations must be static string or number \
                         values.\n\
                         Hint: extract the value to a constant.",
                        filename, line, col
                    )));
                }
            }
        }
    }

    // Wrap in @keyframes with placeholder
    let placeholder_name = "__kf_placeholder__";
    let raw_css = format!("@keyframes {} {{ {} }}", placeholder_name, inner.trim());

    let hash_input = format!("{}:{}", filename, tpl.span.start);
    let hash = hash_css(&hash_input);
    let kf_name = format!("kf_{}", hash);

    let (css_code, css_map) = run_lightningcss(&raw_css, filename, dir)?;
    let final_css = css_code.replace(placeholder_name, &kf_name);

    Ok((hash, kf_name, final_css, css_map))
}

// ---------------------------------------------------------------------------
// Detect whether an arrow / function expression is the `({ theme }) => ...`
// pattern that css() uses for theming. Returns the body ObjectExpression if so.
// ---------------------------------------------------------------------------

fn extract_theme_arrow_body<'a>(expr: &'a Expression<'a>) -> Option<&'a ObjectExpression<'a>> {
    let arrow = match expr {
        Expression::ArrowFunctionExpression(a) => a,
        _ => return None,
    };

    // Must have exactly one parameter
    if arrow.params.items.len() != 1 {
        return None;
    }

    // Walk all statements in the arrow body looking for an object expression
    for stmt in &arrow.body.statements {
        match stmt {
            // Concise body represented as ExpressionStatement: `=> ({ ... })`
            Statement::ExpressionStatement(es) => {
                match &es.expression {
                    Expression::ObjectExpression(obj) => return Some(obj),
                    Expression::ParenthesizedExpression(pe) => {
                        if let Expression::ObjectExpression(obj) = &pe.expression {
                            return Some(obj);
                        }
                    }
                    _ => {}
                }
            }
            // Block body with explicit return: `=> { return { ... } }`
            Statement::ReturnStatement(ret) => {
                match &ret.argument {
                    Some(Expression::ObjectExpression(obj)) => return Some(obj),
                    Some(Expression::ParenthesizedExpression(pe)) => {
                        if let Expression::ObjectExpression(obj) = &pe.expression {
                            return Some(obj);
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Main NAPI export
// ---------------------------------------------------------------------------

#[napi]
pub fn transform(
    filename: String,
    source_code: String,
    theme_json: Option<String>,
    dir: Option<String>,
) -> Result<TransformResult> {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(&filename).unwrap_or_default();

    let ParserReturn { program, errors, panicked, .. } =
        Parser::new(&allocator, &source_code, source_type)
            .with_options(ParseOptions::default())
            .parse();

    if panicked || !errors.is_empty() {
        return Ok(TransformResult {
            code: source_code,
            css_rules: vec![],
            global_css: vec![],
            keyframes: vec![],
            map: None,
        });
    }

    // Parse optional theme JSON
    let theme: Option<serde_json::Value> = theme_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());

    // Resolve text direction (default: "ltr")
    let dir = dir.as_deref().unwrap_or("ltr");

    // Replacements: (byte_start, byte_end, replacement_string)
    let mut replacements: Vec<(u32, u32, String)> = vec![];
    let mut css_rules: Vec<ExtractedCssRule> = vec![];
    let mut global_css: Vec<GlobalCssRule> = vec![];
    let mut keyframes: Vec<KeyframeRule> = vec![];

    // Map from JS identifier name → resolved kf_<hash> animation name.
    // Built up as we encounter keyframes`...` declarations (source order matters).
    let mut keyframe_names: HashMap<String, String> = HashMap::new();

    let mut ctx = WalkCtx {
        replacements: &mut replacements,
        css_rules: &mut css_rules,
        global_css: &mut global_css,
        keyframes: &mut keyframes,
        keyframe_names: &mut keyframe_names,
        filename: &filename,
        source: &source_code,
        theme: theme.as_ref(),
        dir,
    };

    for stmt in &program.body {
        walk_statement_ctx(stmt, &mut ctx)?;
    }

    if replacements.is_empty() {
        return Ok(TransformResult {
            code: source_code,
            css_rules: vec![],
            global_css: vec![],
            keyframes: vec![],
            map: None,
        });
    }

    // JS source map via codegen
    let js_map: Option<String> = Codegen::new()
        .with_options(CodegenOptions {
            source_map_path: Some(Path::new(&filename).into()),
            ..CodegenOptions::default()
        })
        .with_source_text(&source_code)
        .build(&program)
        .map
        .map(|sm| sm.to_json_string());

    // Apply byte-range replacements (largest offset first to preserve positions)
    let mut output = source_code.clone();
    replacements.sort_by(|a, b| b.0.cmp(&a.0));
    for (start, end, replacement) in &replacements {
        output.replace_range(
            (*start as usize)..(*end as usize),
            replacement,
        );
    }

    Ok(TransformResult { code: output, css_rules, global_css, keyframes, map: js_map })
}

// ---------------------------------------------------------------------------
// Walk context (avoids threading 8 parameters through every function)
// ---------------------------------------------------------------------------

struct WalkCtx<'b> {
    replacements: &'b mut Vec<(u32, u32, String)>,
    css_rules: &'b mut Vec<ExtractedCssRule>,
    global_css: &'b mut Vec<GlobalCssRule>,
    keyframes: &'b mut Vec<KeyframeRule>,
    keyframe_names: &'b mut HashMap<String, String>,
    filename: &'b str,
    source: &'b str,
    theme: Option<&'b serde_json::Value>,
    dir: &'b str,
}

// ---------------------------------------------------------------------------
// AST walkers
// ---------------------------------------------------------------------------

fn walk_statement_ctx<'a, 'b>(
    stmt: &Statement<'a>,
    ctx: &mut WalkCtx<'b>,
) -> Result<()> {
    match stmt {
        Statement::ExpressionStatement(es) => {
            walk_expression_ctx(&es.expression, ctx, None)?;
        }
        Statement::VariableDeclaration(vd) => {
            for decl in &vd.declarations {
                // Track the binding name so keyframe_names can be populated
                let binding_name: Option<String> = decl.id.get_binding_identifier()
                    .map(|id| id.name.to_string());
                if let Some(init) = &decl.init {
                    walk_expression_ctx(init, ctx, binding_name.as_deref())?;
                }
            }
        }
        Statement::ReturnStatement(rs) => {
            if let Some(arg) = &rs.argument {
                walk_expression_ctx(arg, ctx, None)?;
            }
        }
        Statement::BlockStatement(bs) => {
            for s in &bs.body {
                walk_statement_ctx(s, ctx)?;
            }
        }
        Statement::FunctionDeclaration(fd) => {
            if let Some(body) = &fd.body {
                for s in &body.statements {
                    walk_statement_ctx(s, ctx)?;
                }
            }
        }
        Statement::ExportNamedDeclaration(en) => {
            if let Some(decl) = &en.declaration {
                walk_declaration_ctx(decl, ctx)?;
            }
        }
        Statement::ExportDefaultDeclaration(ed) => {
            if let Some(expr) = ed.declaration.as_expression() {
                walk_expression_ctx(expr, ctx, None)?;
            } else if let ExportDefaultDeclarationKind::FunctionDeclaration(fd) = &ed.declaration {
                if let Some(body) = &fd.body {
                    for s in &body.statements {
                        walk_statement_ctx(s, ctx)?;
                    }
                }
            }
        }
        Statement::IfStatement(is_stmt) => {
            walk_statement_ctx(&is_stmt.consequent, ctx)?;
            if let Some(alt) = &is_stmt.alternate {
                walk_statement_ctx(alt, ctx)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn walk_declaration_ctx<'a, 'b>(
    decl: &Declaration<'a>,
    ctx: &mut WalkCtx<'b>,
) -> Result<()> {
    match decl {
        Declaration::VariableDeclaration(vd) => {
            for d in &vd.declarations {
                let binding_name: Option<String> = d.id.get_binding_identifier()
                    .map(|id| id.name.to_string());
                if let Some(init) = &d.init {
                    walk_expression_ctx(init, ctx, binding_name.as_deref())?;
                }
            }
        }
        Declaration::FunctionDeclaration(fd) => {
            if let Some(body) = &fd.body {
                for s in &body.statements {
                    walk_statement_ctx(s, ctx)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn walk_expression_ctx<'a, 'b>(
    expr: &Expression<'a>,
    ctx: &mut WalkCtx<'b>,
    binding_name: Option<&str>,
) -> Result<()> {
    match expr {
        // ── css({}) or css(({ theme }) => ({ ... })) ──────────────────────
        Expression::CallExpression(call) => {
            let callee_name = match &call.callee {
                Expression::Identifier(id) => Some(id.name.as_str()),
                _ => None,
            };

            match callee_name {
                Some("css") => {
                    if let Some(first_arg) = call.arguments.first() {
                        if let Some(arg_expr) = first_arg.as_expression() {
                            // Object form: css({ ... })
                            if let Expression::ObjectExpression(obj) = arg_expr {
                                match process_css_object(obj, call.span.start, ctx.filename, ctx.source, ctx.theme, ctx.keyframe_names, ctx.dir) {
                                    Ok((class_name, css_text, css_map)) => {
                                        ctx.replacements.push((call.span.start, call.span.end, format!("\"{}\"", class_name)));
                                        let hash = class_name.strip_prefix("cls_").unwrap_or(&class_name).to_string();
                                        ctx.css_rules.push(ExtractedCssRule { hash, css: css_text, map: css_map });
                                        return Ok(());
                                    }
                                    Err(e) => return Err(e),
                                }
                            }

                            // Function form: css(({ theme }) => ({ ... }))
                            if let Some(body_obj) = extract_theme_arrow_body(arg_expr) {
                                match process_css_object(body_obj, call.span.start, ctx.filename, ctx.source, ctx.theme, ctx.keyframe_names, ctx.dir) {
                                    Ok((class_name, css_text, css_map)) => {
                                        ctx.replacements.push((call.span.start, call.span.end, format!("\"{}\"", class_name)));
                                        let hash = class_name.strip_prefix("cls_").unwrap_or(&class_name).to_string();
                                        ctx.css_rules.push(ExtractedCssRule { hash, css: css_text, map: css_map });
                                        return Ok(());
                                    }
                                    Err(e) => return Err(e),
                                }
                            }
                        }
                    }

                    // Recurse into callee and args for nested calls
                    walk_expression_ctx(&call.callee, ctx, None)?;
                    for arg in &call.arguments {
                        if let Some(e) = arg.as_expression() {
                            walk_expression_ctx(e, ctx, None)?;
                        }
                    }
                }

                // (Other call expressions — recurse)
                _ => {
                    walk_expression_ctx(&call.callee, ctx, None)?;
                    for arg in &call.arguments {
                        if let Some(e) = arg.as_expression() {
                            walk_expression_ctx(e, ctx, None)?;
                        }
                    }
                }
            }
        }

        // ── globalCss`...` tagged template ────────────────────────────────
        Expression::TaggedTemplateExpression(tagged) => {
            let is_global_css = matches!(
                &tagged.tag,
                Expression::Identifier(id) if id.name.as_str() == "globalCss"
            );
            let is_keyframes = matches!(
                &tagged.tag,
                Expression::Identifier(id) if id.name.as_str() == "keyframes"
            );

            if is_global_css {
                match process_global_css_template(&tagged.quasi, ctx.filename, ctx.source, ctx.theme, ctx.dir) {
                    Ok((hash, css_text, css_map)) => {
                        // Replace the call expression with `undefined` (side-effect: the import
                        // is prepended in the Vite plugin)
                        ctx.replacements.push((tagged.span.start, tagged.span.end, "undefined".to_string()));
                        ctx.global_css.push(GlobalCssRule { hash, css: css_text, map: css_map });
                        return Ok(());
                    }
                    Err(e) => return Err(e),
                }
            }

            if is_keyframes {
                match process_keyframes_template(&tagged.quasi, ctx.filename, ctx.source, ctx.dir) {
                    Ok((hash, kf_name, css_text, css_map)) => {
                        ctx.replacements.push((tagged.span.start, tagged.span.end, format!("\"{}\"", kf_name)));
                        // Register the binding name → kf_name for later css() interpolation
                        if let Some(name) = binding_name {
                            ctx.keyframe_names.insert(name.to_string(), kf_name.clone());
                        }
                        ctx.keyframes.push(KeyframeRule { hash, name: kf_name, css: css_text, map: css_map });
                        return Ok(());
                    }
                    Err(e) => return Err(e),
                }
            }
        }

        Expression::ArrowFunctionExpression(arrow) => {
            for s in &arrow.body.statements {
                walk_statement_ctx(s, ctx)?;
            }
        }

        Expression::JSXElement(el) => {
            for attr in &el.opening_element.attributes {
                if let JSXAttributeItem::Attribute(a) = attr {
                    if let Some(JSXAttributeValue::ExpressionContainer(ec)) = &a.value {
                        if let Some(e) = ec.expression.as_expression() {
                            walk_expression_ctx(e, ctx, None)?;
                        }
                    }
                }
            }
            for child in &el.children {
                if let JSXChild::ExpressionContainer(ec) = child {
                    if let Some(e) = ec.expression.as_expression() {
                        walk_expression_ctx(e, ctx, None)?;
                    }
                }
            }
        }

        Expression::ParenthesizedExpression(pe) => {
            walk_expression_ctx(&pe.expression, ctx, None)?;
        }

        _ => {}
    }
    Ok(())
}