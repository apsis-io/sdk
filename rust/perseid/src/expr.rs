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
    /// A STRING. No SYMBOL results in one - like `Path`, it is a parameter type
    /// in aperture's table - but a ConfigMap's or Secret's `data(o, key)` does,
    /// so the marker exists for that subscript and for nothing else.
    Str => "string",
    /// A set of pods; `.length` is an `Int`.
    Pods => "pods",
    /// A STRING THAT NAMES AN OBJECT. Distinct from `Str` because the write
    /// boundary reads the object out of the argument typed this way rather than
    /// guessing it from position.
    Path => "path",
    /// ONE FIELD of ONE OBJECT, three-valued - what `get` produces.
    ///
    /// It replaced `Pod`, `Workload` and `Object`, which were the result types
    /// of the eight per-kind read symbols. Those types existed to carry which
    /// PROPERTIES were reachable - `.replicas` and `.ready` on a workload,
    /// `data(o, key)` on an object - and `get` names the field directly, so
    /// there is no object left in the language to take a property OF.
    Value => "value",
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

/// `Get(path, field) -> value`. THE READ, for every kind.
///
/// engi, 2026-08-30: *"write generalized read - deprecate specialized reads
/// (GetConfigMap, ...)"*.
///
/// ```ignore
/// get(&deployment("default", "api")?, "status.readyReplicas")
/// get(&config_map("default", "cfg")?, "data.mode")
/// ```
///
/// It replaced `get_pod`, `replicas`, `get_deployment`, `get_stateful_set`,
/// `get_daemon_set`, `get_replica_set`, `get_config_map` and `get_secret` -
/// eight functions differing only in the kind they named and the two fields
/// they exposed. The path already says the kind.
///
/// **THE AUTHORITY DID NOT COLLAPSE WITH THE SYMBOL.** `Get` is conferred by
/// every read capability, and the host checks the PATH'S KIND against the
/// granted set at evaluation - so `pods:read` lets this read pods and does not
/// let it read a Secret. `secrets:read` is still absent from the host's fixed
/// resume capability set, so a `Get` naming a Secret does not resolve in a WAKE
/// CONDITION and cannot publish a claim about a secret's value into
/// `status.waitingFor`. Read secrets in a STEP.
///
/// **A FIELD, NEVER THE OBJECT.** The host narrows to the single field named
/// here before the language sees anything. A missing field is ABSENT rather
/// than unknown - the object was read, the field genuinely is not there - so
/// `exists` on an optional field is a real question rather than a frozen
/// program.
#[must_use]
pub fn get(path: impl PathArg, field: &str) -> Expr<Value> {
    Expr::new(format!("Get({}, {})", path.path_text(), lit(field)))
}

/// `ListPods(selector) -> pods`. A LABEL SELECTOR (`app=api`), never a path.
///
/// Passing a path here is the defect the reconcile contract already paid for:
/// the host answered `unknown` forever and nothing reported it.
#[must_use]
pub fn list_pods(selector: &str) -> Expr<Pods> {
    Expr::new(format!("ListPods({})", lit(selector)))
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
impl Observed for ObservedInt {}
impl Observed for Value {}

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
// EIGHT PER-KIND CONSTRUCTORS WERE HERE AND ARE DELETED, 2026-08-30.
//
// `get_pod`, `replicas`, `get_deployment`, `get_stateful_set`, `get_daemon_set`,
// `get_replica_set`, `get_config_map`, `get_secret` - and the `desired`, `ready`
// and `data` properties only they produced. `get(path, field)` is all of them.
//
// **THE COMMENT THAT USED TO SIT HERE ARGUED THEY WERE NECESSARY, AND IT WAS
// WRONG ON THE MECHANISM.** It said a generic `get(kind, name)` "would emit an
// expression the host cannot index, so a parked program would fall back to
// polling, silently" - because `Addresses.Kind` is static per symbol. True of a
// KIND-plus-NAME spelling; false of the one that shipped. A full path carries
// namespace, kind and name, so `Addressing.ByPath` indexes it exactly - and more
// precisely than the old form, which had to borrow its namespace from the grant.
//
// Recorded rather than deleted: the argument was load-bearing for months and
// reads as sound. What it got wrong was assuming the generic form had to be
// (kind, name).

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
/// **A WIDENING, AND IT IS THE PRICE OF ONE SYMBOL READING EVERY KIND.** A
/// `Value` may hold a string, so `ne(get(&cfg, "data.mode"), 3)` now compiles
/// where the per-kind types would have rejected it. The host is three-valued
/// rather than typed at that point and answers UNKNOWN for a comparison against
/// a non-number, so the failure is a program that never wakes rather than a
/// wrong answer - the same latitude `ObservedInt` always had, over a wider set.
impl IntLike for Expr<Value> {
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

/// `Ensure(path, field, value) -> effect`. THE WRITE, for every kind.
///
/// The mirror of [`get`], and it replaced `set_replicas` (engi, 2026-08-30:
/// *"deprecate specialized writes"*).
///
/// ```ignore
/// ensure(&deployment("default", "api")?, "spec.replicas", 3);
/// ensure(&config_map("default", "cfg")?, "data.mode", "fast");
/// ensure(&dep, "spec.replicas", plus(length(&list_pods("app=x")), 2));
/// ```
///
/// **A LITERAL AND AN EXPRESSION ARE DIFFERENT TYPES HERE, WHICH IS WHY THIS
/// NEEDS NO MARKER.** The TypeScript SDK has to wrap a computed value in
/// `computed(...)`: an `Expr` is a plain string at runtime there, so nothing can
/// tell `"fast"` (a value to quote) from `Get(...) + 1` (text to emit bare), and
/// deciding it by the string's SHAPE would emit a ConfigMap value that happens
/// to read `Now()` as a CLOCK READ. In Rust `&str` and `Expr<T>` are distinct
/// types, so the [`EnsureValue`] impls settle it at compile time and the common
/// case stays a bare literal.
///
/// **THE DECLARATION IS THE OBJECT.** `spec.writes` names the object and that is
/// complete access to it; which field you write is not a second grant. A
/// field-scoped boundary was tried and removed - enumerating fields does not
/// scale, and `spec.writes` exists for admission-time CONFLICT DETECTION, which
/// reasons about objects, so field-scoping would have made two programs writing
/// one object stop looking like a conflict.
///
/// What bounds this instead is its OWN capability (`radiant:reconcile/ensure`,
/// so no existing scaler silently gains it), the grant's namespace, and the
/// KIND: configmaps, secrets, deployments, statefulsets, daemonsets,
/// replicasets. **Not pods** - an obligation is applied with RADIANT's
/// credential, which the seam-binding admission policy exempts on pods.
#[must_use]
pub fn ensure(path: impl PathArg, field: &str, value: impl EnsureValue) -> Expr<Effect> {
    Expr::new(format!(
        "Ensure({}, {}, {})",
        path.path_text(),
        lit(field),
        value.value_text()
    ))
}

/// `At(apiVersion, kind, name) -> path`. Name an object WITHOUT a namespace.
///
/// ```ignore
/// get(&at("apps/v1", "deployments", "web"), "status.readyReplicas")
/// ensure(&at("v1", "configmaps", "cfg"), "data.mode", "fast")
/// ```
///
/// **THE NAMESPACE COMES FROM THE GRANT, AND A PROGRAM CANNOT SUPPLY ONE.** Not
/// "is refused when it tries" - cannot say it. `reconcile.wit` argues the same
/// point about `count`: a path "lets a program NAME one - which then has to be
/// checked against the grant, so the boundary gains a SECOND ENFORCEMENT POINT
/// THAT CAN DISAGREE WITH THE FIRST".
///
/// The apiVersion is spelled as an object's own `apiVersion` field spells it -
/// `apps/v1`, or `v1` for the core group - rather than as a group and a version
/// nobody orders correctly.
///
/// An OBLIGATION built from one still stores a plain path: an effect evaluates
/// its arguments and renders the result, so nothing downstream sees an `At`.
#[must_use]
pub fn at(api_version: &str, kind: &str, name: &str) -> Expr<Path> {
    Expr::new(format!(
        "At({}, {}, {})",
        lit(api_version),
        lit(kind),
        lit(name)
    ))
}

/// Anywhere a path goes: a BUILT path, or an `at(...)` that resolves to one.
///
/// **THE TWO ARE NOT INTERCHANGEABLE IN STRENGTH AND BOTH ARE LEGITIMATE.** An
/// `ApiPath` states a namespace, which the host then checks against the grant -
/// a second enforcement point that CAN disagree. An `at(...)` cannot state one,
/// so there is nothing to check. The second is stronger; the first is what you
/// need when the object is genuinely addressed another way.
///
/// A trait rather than an enum for the reason `EnsureValue` is one: the call
/// site reads `get(&at(..), "f")` and `get(&dep, "f")` identically, and the
/// types decide which text to emit.
pub trait PathArg {
    /// Render this as a path argument: a quoted literal, or bare expression text.
    fn path_text(self) -> String;
}

impl PathArg for &crate::path::ApiPath {
    fn path_text(self) -> String {
        lit(self.as_str())
    }
}

impl PathArg for &Expr<Path> {
    fn path_text(self) -> String {
        self.as_str().to_string()
    }
}

/// `Create(path, body) -> effect`. Bring an object into existence.
///
/// **THE PATH IS THE IDENTITY; THE BODY IS EVERYTHING ELSE.** A canonical path
/// already carries group, version, resource, namespace and name - every field
/// of a new object's identity - so the body holds `spec`, labels and the like.
/// A body that sets `apiVersion`, `kind`, `metadata.name` or
/// `metadata.namespace` is REFUSED by the host: the path is the string
/// `spec.writes` was checked against, and a body that could name a different
/// object would put it outside the address that was approved.
///
/// **KEYS RENDER SORTED.** The obligation's identity IS its expression text, so
/// two passes building the same body must produce byte-identical strings or the
/// ledger sees a new obligation every pass and re-applies it forever.
#[must_use]
pub fn create(path: impl PathArg, body: &Struct) -> Expr<Effect> {
    Expr::new(format!("Create({}, {})", path.path_text(), body.render()))
}

/// `EnsureAll(path, body) -> effect`. SEVERAL fields of one object, ONE apiserver
/// patch, so a reader can never observe the new value of one beside the old
/// value of another.
///
/// **`ensure` IS ONE FIELD PER OBLIGATION AND OBLIGATIONS APPLY ONE AT A TIME.** A
/// step writing `data.v` and a `data.t` stamp as two ensures produced a durable
/// torn pair - 3 of 6 convergences observed with new `v` beside old `t`
/// (overhead-bench, 2026-09-01). Same body type and renderer as [`create`], so
/// keys are SORTED: the expression is the ledger identity.
///
/// **`spec.replicas` ON AN apps KIND IS REFUSED BY THE HOST** - it goes through the
/// `/scale` subresource and the apiserver has no write atomic across that
/// boundary. Use [`ensure`] for the count.
#[must_use]
pub fn ensure_all(path: impl PathArg, body: &Struct) -> Expr<Effect> {
    Expr::new(format!("EnsureAll({}, {})", path.path_text(), body.render()))
}

/// A structured value: an object body for [`create`].
///
/// **A BUILDER RATHER THAN A MAP LITERAL, SO THE RENDERING IS CANONICAL BY
/// CONSTRUCTION.** Keys are sorted when rendered, not when inserted, so the
/// caller can build in any order and still get one string.
#[derive(Debug, Clone, Default)]
pub struct Struct {
    fields: std::collections::BTreeMap<String, String>,
}

impl Struct {
    /// An empty body.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a field to a scalar or a computed expression - the same
    /// [`EnsureValue`] split `ensure` uses, and for the same reason: a `&str`
    /// is a literal to quote, an `Expr` is text to emit bare.
    #[must_use]
    pub fn set(mut self, key: &str, value: impl EnsureValue) -> Self {
        self.fields.insert(key.to_string(), value.value_text());
        self
    }

    /// Nest another structured value.
    #[must_use]
    pub fn nest(mut self, key: &str, inner: &Struct) -> Self {
        self.fields.insert(key.to_string(), inner.render());
        self
    }

    fn render(&self) -> String {
        let inner: Vec<String> = self
            .fields
            .iter()
            .map(|(k, v)| format!("{}: {}", lit(k), v))
            .collect();

        format!("{{{}}}", inner.join(", "))
    }
}

/// `Delete(path) -> effect`. Remove the object a path names.
///
/// **THE ONLY IRREVERSIBLE VERB IN THIS LANGUAGE.** Everything else converges
/// toward a declared state and can be re-declared if it lands wrong; a delete
/// cannot be undone by re-running the step.
///
/// **ITS OWN INTERFACE (`radiant:reconcile/delete`), NOT `ensure`'s.** Authority
/// is conferred by IMPORTING an interface, so folding it in would grant it to
/// every program already granted Ensure - and `spec.writes` bounds WHICH object
/// either verb may touch while saying nothing about which VERB, so a scaler
/// would silently gain the ability to delete the Deployment it scales.
///
/// No field: a delete is about the OBJECT, so there is nothing to narrow.
#[must_use]
pub fn delete(path: impl PathArg) -> Expr<Effect> {
    Expr::new(format!("Delete({})", path.path_text()))
}

/// What [`ensure`] may write: a scalar LITERAL, or a computed expression.
///
/// The distinction is the whole point - see [`ensure`]. A `&str` is always a
/// literal to be quoted; an `Expr` is always text to be emitted bare.
pub trait EnsureValue {
    /// Render this as the third argument of an `Ensure` call.
    fn value_text(self) -> String;
}

impl EnsureValue for &str {
    fn value_text(self) -> String {
        lit(self)
    }
}

impl EnsureValue for &String {
    fn value_text(self) -> String {
        lit(self)
    }
}

impl EnsureValue for i64 {
    fn value_text(self) -> String {
        self.to_string()
    }
}

impl EnsureValue for i32 {
    fn value_text(self) -> String {
        self.to_string()
    }
}

impl EnsureValue for bool {
    fn value_text(self) -> String {
        self.to_string()
    }
}

impl<T: ApType> EnsureValue for &Expr<T> {
    fn value_text(self) -> String {
        self.as_str().to_string()
    }
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

    fn dep() -> crate::path::ApiPath {
        crate::path::ns("default").deployments("api")
    }

    #[test]
    fn symbols_render_as_aperture_spells_them() {
        assert_eq!(
            get(&dep(), "spec.replicas").as_str(),
            r#"Get("/apis/apps/v1/namespaces/default/deployments/api", "spec.replicas")"#
        );
        assert_eq!(list_pods("app=api").as_str(), r#"ListPods("app=api")"#);
        assert_eq!(now().as_str(), "Now()");
    }

    #[test]
    fn comparison_and_arithmetic() {
        assert_eq!(
            ne(get(&dep(), "spec.replicas"), 3).as_str(),
            r#"Get("/apis/apps/v1/namespaces/default/deployments/api", "spec.replicas") != 3"#
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
    //
    // Driven through the FIELD argument now that no symbol takes a bare name:
    // `lit` is the one function under test and both arguments go through it.
    #[test]
    fn string_literals_are_json_so_the_host_can_decode_them() {
        let f = |field: &str| get(&dep(), field).as_str().to_string();
        assert!(f(r#"a"b"#).ends_with(r#", "a\"b")"#));
        assert!(f("a\\b").ends_with(r#", "a\\b")"#));
        assert!(f("a\nb").ends_with(r#", "a\nb")"#));
        // A raw control character is rejected by Go's JSON decoder, so it must
        // be escaped rather than passed through.
        assert!(f("a\u{1}b").ends_with(r#", "a\u0001b")"#));
    }

    #[test]
    fn boolean_combinators_parenthesise_their_operands() {
        let a = ne(get(&dep(), "spec.replicas"), 2);
        let b = ne(length(&list_pods("app=api")), 3);
        assert_eq!(
            or(&[a, b]).as_str(),
            r#"(Get("/apis/apps/v1/namespaces/default/deployments/api", "spec.replicas") != 2) || (ListPods("app=api").length != 3)"#
        );
        assert_eq!(not(&ne(1, 2)).as_str(), "!1 != 2");
    }

    #[test]
    fn effects_render_from_the_signature_alone() {
        assert_eq!(
            ensure(&dep(), "spec.replicas", 3).as_str(),
            r#"Ensure("/apis/apps/v1/namespaces/default/deployments/api", "spec.replicas", 3)"#
        );
        assert_eq!(
            set_condition("Ready", ConditionStatus::True, "AtDesiredScale", "3 of 3").as_str(),
            r#"SetCondition("Ready", "True", "AtDesiredScale", "3 of 3")"#
        );
    }

    // ***THE LITERAL/EXPRESSION SPLIT IS THE ONE THING `EnsureValue` EXISTS
    // FOR, SO IT IS ASSERTED BOTH WAYS.*** A `&str` is QUOTED and an `Expr` is
    // emitted BARE; getting either backwards writes the wrong thing into the
    // cluster, and the TypeScript SDK needs a `computed()` wrapper to reach the
    // same place because its `Expr` is a plain string at runtime.
    #[test]
    fn ensure_quotes_a_literal_and_emits_an_expression_bare() {
        let cfg = crate::path::ns("default").resource("", "v1", "configmaps", "cfg");
        assert!(
            ensure(&cfg, "data.mode", "fast")
                .as_str()
                .ends_with(r#", "fast")"#)
        );
        // A string that LOOKS like an expression is still a literal.
        assert!(
            ensure(&cfg, "data.mode", "Now()")
                .as_str()
                .ends_with(r#", "Now()")"#)
        );
        // ...and an actual expression is not quoted.
        assert!(
            ensure(&cfg, "data.mode", &now())
                .as_str()
                .ends_with(", Now())")
        );
        assert!(ensure(&cfg, "data.on", true).as_str().ends_with(", true)"));
    }

    // `.exists` is only implemented for OBSERVED types, so `exists(&now())` is a
    // compile error rather than a host-side refusal. This asserts the positive
    // half; the negative half is in tests/compile_fail.rs, which is the only
    // instrument that can see a type that does not exist.
    #[test]
    fn exists_applies_to_observations() {
        assert_eq!(
            exists(&get(&dep(), "spec.replicas")).as_str(),
            r#"Get("/apis/apps/v1/namespaces/default/deployments/api", "spec.replicas").exists"#
        );
    }
}
