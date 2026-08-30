// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! The aperture expression language, typed.
//!
//! # aperture does not type-check expressions, and the SDK is stricter on purpose
//!
//! `internal/aperture` has a `signatures` table with types, `CheckArity` and
//! `CheckPure`. It is easy to read that as "expressions are type-checked". They
//! are not: the table types PARAMETERS and results for arity and addressing, and
//! nothing walks an expression comparing operand types. The host will happily
//! evaluate `Replicas("api") != "three"`: an int against a string is never
//! equal, so a park on it either wakes immediately forever or never wakes at
//! all, and `quiesce` returns nothing to the guest, so the step cannot see
//! which.
//!
//! That is ADR-0075's "correctly asleep on a condition nobody will satisfy",
//! reached by a typo. So this builder is deliberately STRICTER THAN THE HOST:
//! every rule here is one the host either enforces at eval or cannot express,
//! and none contradicts it.
//!
//! # The type parameter is the safety property
//!
//! [`Expr<T>`] carries its aperture type in a marker, so the compiler enforces
//! what `CheckPure` enforces at the host - and enforces it BEFORE the program
//! ships. An [`Effect`] is not a [`Bool`], and a resume position takes a
//! `Expr<Bool>`, so a write in a wake condition does not compile. The TS SDK
//! reaches the same property with a branded string; Rust gets it from the type
//! system directly.
//!
//! # Types the SDK names that aperture does not
//!
//! `signatures` gives `Replicas` and `Now` the same result type, `Int`. At
//! runtime they differ in a way that matters:
//!
//! ```text
//! GetPod("web").exists      ok    a three-valued observation
//! Replicas("api").exists    ok    also three-valued, despite being Int
//! Now().exists              REFUSED - a bare number; the clock cannot be absent
//! ```
//!
//! `.exists` asks "did this observation resolve", so it belongs to things that
//! are OBSERVED. Hence [`ObservedInt`]: not a type aperture names, but the
//! distinction aperture's runtime makes, given a name so this SDK can enforce it.

use core::fmt;
use core::marker::PhantomData;

/// An aperture type, as a marker.
///
/// Sealed: the set is closed because `signatures` is closed, and a guest-defined
/// type would name something the host cannot parse.
pub trait ApType: private::Sealed {
    /// The wire spelling, matching aperture's `Type` constants lowercased.
    const NAME: &'static str;
}

mod private {
    pub trait Sealed {}
}

/// Macro-free because there are six of them and the expansion would be longer
/// than the list.
macro_rules! aptype {
    ($($(#[$m:meta])* $t:ident => $n:literal),+ $(,)?) => {$(
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub struct $t;
        impl private::Sealed for $t {}
        impl ApType for $t { const NAME: &'static str = $n; }
    )+};
}

aptype! {
    /// A truth value. Three-valued at the host: a comparison against an
    /// unresolved observation is `unknown`, not `false`.
    Bool => "bool",
    /// A number that is READ rather than observed - `Now()`. Cannot be absent,
    /// so `.exists` is refused at evaluation.
    Int => "int",
    /// A number that is OBSERVED, so it may be absent and `.exists` applies.
    ObservedInt => "observed-int",
    /// One pod.
    Pod => "pod",
    /// A set of pods; `.length` is an `Int`.
    Pods => "pods",
    /// An OBLIGATION - something that should be true, performed by radiant.
    ///
    /// Not a value: it cannot be compared, added or used as an argument, and
    /// the host's `CheckPure` refuses any expression producing one in a pure
    /// context. Here that refusal is a type error.
    Effect => "effect",
}

/// An aperture expression of type `T`.
///
/// It IS the expression text - `Display` renders exactly what ships - and it
/// cannot be built from a string by a guest. A hand-written expression is
/// precisely the nonsense the module docs measure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expr<T: ApType> {
    text: String,
    _ty: PhantomData<T>,
}

impl<T: ApType> Expr<T> {
    fn new(text: String) -> Self {
        Self {
            text,
            _ty: PhantomData,
        }
    }

    /// The expression text, for shipping to the host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.text
    }
}

impl<T: ApType> fmt::Display for Expr<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

/// Quote a string literal the way the host decodes it.
///
/// ***THE HOST DECODES WITH `encoding/json`, SO THIS EMITS JSON.*** Producer and
/// consumer are then the same dialect by construction rather than by agreement -
/// the TS SDK reaches the identical property by calling `JSON.stringify`.
///
/// This is not decoration. aperture's string token carried NO escapes until
/// 2026-08-29, and `cmd/trail` rendered condition messages with JSON escaping:
/// the write boundary refused every obligation whose message quoted a policy
/// name, silently, because an action returns nothing to the guest. Getting this
/// wrong reproduces that outage.
fn lit(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // JSON requires escaping every control character; Go's decoder
            // rejects a raw one inside a string.
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');

    out
}

// ---------------------------------------------------------------------------
// Symbols. One per entry in aperture's `signatures` table.

/// `GetPod(name) -> pod`. A NAME, resolved in the grant's namespace.
#[must_use]
pub fn get_pod(name: &str) -> Expr<Pod> {
    Expr::new(format!("GetPod({})", lit(name)))
}

/// `ListPods(selector) -> pods`. A LABEL SELECTOR (`app=api`), never a path.
///
/// Passing a path here is the defect the reconcile contract already paid for:
/// the host answered `unknown` forever and nothing reported it.
#[must_use]
pub fn list_pods(selector: &str) -> Expr<Pods> {
    Expr::new(format!("ListPods({})", lit(selector)))
}

/// `Replicas(name) -> int`, OBSERVED - reads `spec.replicas`, the DESIRED count.
#[must_use]
pub fn replicas(name: &str) -> Expr<ObservedInt> {
    Expr::new(format!("Replicas({})", lit(name)))
}

/// `Now() -> int`. Epoch milliseconds, UTC.
///
/// Typed [`Int`] and not [`ObservedInt`] because the clock cannot be absent, and
/// the host refuses `Now().exists` at evaluation.
#[must_use]
pub fn now() -> Expr<Int> {
    Expr::new("Now()".to_string())
}

// ---------------------------------------------------------------------------
// Properties.

/// Anything `.exists` may be asked of - i.e. anything actually OBSERVED.
pub trait Observed: ApType {}
impl Observed for Pod {}
impl Observed for ObservedInt {}

/// `.exists` - did this observation RESOLVE.
#[must_use]
pub fn exists<T: Observed>(o: &Expr<T>) -> Expr<Bool> {
    Expr::new(format!("{o}.exists"))
}

/// `.length` - how many. Only for a set.
#[must_use]
pub fn length(p: &Expr<Pods>) -> Expr<Int> {
    Expr::new(format!("{p}.length"))
}

// ---------------------------------------------------------------------------
// Integers: literals, comparison, arithmetic.

/// Anything usable where an integer goes: a literal, a clock read, an
/// observation.
///
/// A trait rather than an enum so a call site reads `ne(replicas("api"), 3)`
/// without wrapping - and so a `Expr<Bool>` cannot be passed, which is the rule
/// the host does not enforce.
pub trait IntLike {
    /// The text this contributes to an expression.
    fn int_text(&self) -> String;
}

impl IntLike for i64 {
    fn int_text(&self) -> String {
        self.to_string()
    }
}
impl IntLike for i32 {
    fn int_text(&self) -> String {
        self.to_string()
    }
}
impl IntLike for Expr<Int> {
    fn int_text(&self) -> String {
        self.text.clone()
    }
}
impl IntLike for Expr<ObservedInt> {
    fn int_text(&self) -> String {
        self.text.clone()
    }
}
impl<T: IntLike> IntLike for &T {
    fn int_text(&self) -> String {
        (*self).int_text()
    }
}

macro_rules! cmp_op {
    ($($(#[$m:meta])* $f:ident => $op:literal),+ $(,)?) => {$(
        $(#[$m])*
        #[must_use]
        pub fn $f(a: impl IntLike, b: impl IntLike) -> Expr<Bool> {
            Expr::new(format!("{} {} {}", a.int_text(), $op, b.int_text()))
        }
    )+};
}

cmp_op! {
    /// `a != b`.
    ne => "!=",
    /// `a == b`.
    eq => "==",
    /// `a < b`.
    lt => "<",
    /// `a <= b`.
    le => "<=",
    /// `a > b`.
    gt => ">",
    /// `a >= b`.
    ge => ">=",
}

macro_rules! arith_op {
    ($($(#[$m:meta])* $f:ident => $op:literal),+ $(,)?) => {$(
        $(#[$m])*
        #[must_use]
        pub fn $f(a: impl IntLike, b: impl IntLike) -> Expr<Int> {
            Expr::new(format!("{} {} {}", a.int_text(), $op, b.int_text()))
        }
    )+};
}

// ***THERE IS NO DIVISION, AND ITS ABSENCE IS A DECISION RATHER THAN AN
// OMISSION.*** Divide-by-zero in a three-valued language has three defensible
// answers - a hard error, `unknown`, or a silent zero - and none has been
// chosen. The grammar has `+ - *` and stops; nothing here can produce `/`.
arith_op! {
    /// `a + b`.
    plus => "+",
    /// `a - b`. BINARY ONLY: the grammar has no unary minus, so `-1` does not
    /// parse and a negative literal is unspellable.
    minus => "-",
    /// `a * b`.
    times => "*",
}

// ---------------------------------------------------------------------------
// Boolean operators.

/// `!b`.
#[must_use]
pub fn not(b: &Expr<Bool>) -> Expr<Bool> {
    Expr::new(format!("!{b}"))
}

/// Wake if ANY holds.
#[must_use]
pub fn or(bs: &[Expr<Bool>]) -> Expr<Bool> {
    Expr::new(
        bs.iter()
            .map(|b| format!("({b})"))
            .collect::<Vec<_>>()
            .join(" || "),
    )
}

/// Wake only if ALL hold.
///
/// A conjunction of pure time bounds has nothing to watch and degrades to
/// polling. For a guaranteed wake, put the deadline in an [`or`].
#[must_use]
pub fn and(bs: &[Expr<Bool>]) -> Expr<Bool> {
    Expr::new(
        bs.iter()
            .map(|b| format!("({b})"))
            .collect::<Vec<_>>()
            .join(" && "),
    )
}

// ---------------------------------------------------------------------------
// Effects.
//
// Effects are ORDINARY EXPRESSIONS as of 2026-08-29 - not opcodes beside the
// language. One vocabulary for reads and writes is what made the wake index
// possible: a park's subject and a write's target became comparable.

/// `SetReplicas(path, n) -> effect`.
///
/// The count may be an EXPRESSION, which is what arithmetic bought:
/// `set_replicas(&p, plus(length(&list_pods("app=x")), 2))`. The host evaluates
/// the argument at emit time, so the stored obligation carries the resulting
/// literal - a step's conclusion is fixed when it declares it.
///
/// Takes a [`crate::path::ApiPath`] rather than a string: the first parameter is
/// typed `Path` in aperture so `TargetOf` can read the object being written
/// instead of inferring it from position.
#[must_use]
pub fn set_replicas(path: &crate::path::ApiPath, n: impl IntLike) -> Expr<Effect> {
    Expr::new(format!(
        "SetReplicas({}, {})",
        lit(path.as_str()),
        n.int_text()
    ))
}

/// The three spellings the Kubernetes CRD enumerates for a condition status.
///
/// An enum and not a string: the CRD accepts exactly these, and a lower-cased
/// value is well-formed JSON that FAILS apiserver validation - rejected at write
/// time, invisible to the step because `set` returns nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConditionStatus {
    /// `"True"`.
    True,
    /// `"False"`.
    False,
    /// `"Unknown"`.
    Unknown,
}

impl ConditionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::True => "True",
            Self::False => "False",
            Self::Unknown => "Unknown",
        }
    }
}

/// `SetCondition(type, status, reason, message) -> effect`. SELF-TARGETED.
///
/// ***IT TAKES NO PATH, AND THAT IS THE POINT.*** The subject is the grant's own
/// Perseid, supplied by the host from the aperture. A path argument would exist
/// only to be validated back to the single value it is allowed to hold, and a
/// step cannot report on another Perseid because there is nothing to bind
/// wrongly.
#[must_use]
pub fn set_condition(
    type_: &str,
    status: ConditionStatus,
    reason: &str,
    message: &str,
) -> Expr<Effect> {
    Expr::new(format!(
        "SetCondition({}, {}, {}, {})",
        lit(type_),
        lit(status.as_str()),
        lit(reason),
        lit(message)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbols_render_as_aperture_spells_them() {
        assert_eq!(get_pod("web").as_str(), r#"GetPod("web")"#);
        assert_eq!(list_pods("app=api").as_str(), r#"ListPods("app=api")"#);
        assert_eq!(replicas("api").as_str(), r#"Replicas("api")"#);
        assert_eq!(now().as_str(), "Now()");
    }

    #[test]
    fn comparison_and_arithmetic() {
        assert_eq!(ne(replicas("api"), 3).as_str(), r#"Replicas("api") != 3"#);
        assert_eq!(
            ne(length(&list_pods("app=api")), replicas("api")).as_str(),
            r#"ListPods("app=api").length != Replicas("api")"#
        );
        // Arithmetic binds tighter than comparison in the grammar, so the
        // rendered form needs no parentheses to mean `(a + 2) > b`.
        assert_eq!(
            plus(length(&list_pods("app=x")), 2).as_str(),
            r#"ListPods("app=x").length + 2"#
        );
        assert_eq!(times(2, 3).as_str(), "2 * 3");
        assert_eq!(minus(5, 1).as_str(), "5 - 1");
    }

    // ***THE ESCAPING TEST IS NOT COSMETIC.*** An unescaped quote produces an
    // expression the host cannot parse, the write boundary refuses the
    // obligation, and the guest is told nothing - the exact shape that dropped
    // every apogeos condition for hours.
    #[test]
    fn string_literals_are_json_so_the_host_can_decode_them() {
        assert_eq!(get_pod(r#"a"b"#).as_str(), r#"GetPod("a\"b")"#);
        assert_eq!(get_pod("a\\b").as_str(), r#"GetPod("a\\b")"#);
        assert_eq!(get_pod("a\nb").as_str(), r#"GetPod("a\nb")"#);
        // A raw control character is rejected by Go's JSON decoder, so it must
        // be escaped rather than passed through.
        assert_eq!(get_pod("a\u{1}b").as_str(), r#"GetPod("a\u0001b")"#);
    }

    #[test]
    fn boolean_combinators_parenthesise_their_operands() {
        let a = ne(replicas("api"), 2);
        let b = ne(length(&list_pods("app=api")), replicas("api"));
        assert_eq!(
            or(&[a, b]).as_str(),
            r#"(Replicas("api") != 2) || (ListPods("app=api").length != Replicas("api"))"#
        );
        assert_eq!(not(&ne(1, 2)).as_str(), "!1 != 2");
    }

    #[test]
    fn effects_render_from_the_signature_alone() {
        let p = crate::path::ns("default").deployments("api");
        assert_eq!(
            set_replicas(&p, 3).as_str(),
            r#"SetReplicas("/apis/apps/v1/namespaces/default/deployments/api", 3)"#
        );
        assert_eq!(
            set_condition("Ready", ConditionStatus::True, "AtDesiredScale", "3 of 3").as_str(),
            r#"SetCondition("Ready", "True", "AtDesiredScale", "3 of 3")"#
        );
    }

    // `.exists` is only implemented for OBSERVED types, so `exists(&now())` is a
    // compile error rather than a host-side refusal. This asserts the positive
    // half; the negative half is in tests/compile_fail.rs, which is the only
    // instrument that can see a type that does not exist.
    #[test]
    fn exists_applies_to_observations() {
        assert_eq!(exists(&get_pod("web")).as_str(), r#"GetPod("web").exists"#);
        assert_eq!(
            exists(&replicas("api")).as_str(),
            r#"Replicas("api").exists"#
        );
    }
}
