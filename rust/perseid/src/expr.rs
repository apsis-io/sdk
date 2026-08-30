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
    /// One pod.
    Pod => "pod",
    /// A set of pods; `.length` is an `Int`.
    Pods => "pods",
    /// A CONTROLLER, reduced to two numbers before the language sees it:
    /// `.replicas` (desired) and `.ready`. Deployment, StatefulSet, DaemonSet
    /// and ReplicaSet all produce one - they differ in what they schedule, not
    /// in what an operator program needs to know.
    Workload => "workload",
    /// A ConfigMap or Secret. `.exists`, and `data(o, key)` by subscript -
    /// never a bare `.data`, which would hand over every key.
    Object => "object",
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
impl Observed for Workload {}
impl Observed for Object {}

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
// Native Kubernetes controllers and objects.
//
// One constructor per kind, because aperture types one SYMBOL per kind - and it
// does that because `Addresses.Kind` is static and the wake index reads it. A
// `get(kind, name)` here would be shorter and would emit an expression the host
// cannot index, so a parked program would fall back to polling, silently.

/// `GetDeployment(name) -> workload`. Adds `.ready`, which `replicas` lacks.
#[must_use]
pub fn get_deployment(name: &str) -> Expr<Workload> {
    Expr::new(format!("GetDeployment({})", lit(name)))
}

/// `GetStatefulSet(name) -> workload`.
#[must_use]
pub fn get_stateful_set(name: &str) -> Expr<Workload> {
    Expr::new(format!("GetStatefulSet({})", lit(name)))
}

/// `GetDaemonSet(name) -> workload`.
///
/// Its desired count is `desiredNumberScheduled` - a function of which NODES
/// match, not a number anybody set. Observe against it; reconciling toward it is
/// a category error.
#[must_use]
pub fn get_daemon_set(name: &str) -> Expr<Workload> {
    Expr::new(format!("GetDaemonSet({})", lit(name)))
}

/// `GetReplicaSet(name) -> workload`.
///
/// Usually owned by a Deployment, so writing to one fights the controller that
/// will overwrite it. There is no effect symbol addressing replicasets.
#[must_use]
pub fn get_replica_set(name: &str) -> Expr<Workload> {
    Expr::new(format!("GetReplicaSet({})", lit(name)))
}

/// `GetConfigMap(name) -> object`.
#[must_use]
pub fn get_config_map(name: &str) -> Expr<Object> {
    Expr::new(format!("GetConfigMap({})", lit(name)))
}

/// `GetSecret(name) -> object`.
///
/// ***USABLE IN A STEP, REFUSED IN A RESUME, AND THAT IS ENFORCED RATHER THAN
/// ADVISED.*** The host evaluates a wake condition WITHOUT running the step, so
/// it cannot consult the guest's `spec.capabilities` and uses a fixed capability
/// set instead (`reconcilehost.resumeCaps`). `secrets:read` is deliberately not
/// in it, so `GetSecret(...)` does not RESOLVE in a resume at all.
///
/// That closes the leak this would otherwise be: a resume is rendered into
/// `status.waitingFor`, which anyone with `get perseid` can read, so parking on
/// a secret's value would publish a claim about it.
///
/// Read a Secret in the STEP, where `spec.capabilities` and radiant's RBAC both
/// gate the call. To WAIT for one, park on something you may observe.
#[must_use]
pub fn get_secret(name: &str) -> Expr<Object> {
    Expr::new(format!("GetSecret({})", lit(name)))
}

/// `.replicas` - what somebody ASKED FOR.
///
/// Named `desired` because `replicas` is already the symbol that reads a
/// deployment's count directly; the emitted property is `.replicas` either way.
#[must_use]
pub fn desired(w: &Expr<Workload>) -> Expr<ObservedInt> {
    Expr::new(format!("{w}.replicas"))
}

/// `.ready` - what the controller reports is actually serving.
#[must_use]
pub fn ready(w: &Expr<Workload>) -> Expr<ObservedInt> {
    Expr::new(format!("{w}.ready"))
}

/// `.data["key"]` on a ConfigMap or Secret.
///
/// A SUBSCRIPT AND NEVER A BARE `.data`: naming the map would hand over every
/// key. The key is a string literal in the grammar, so the readable key set is
/// knowable at parse time and nobody can make an expression resolve differently
/// by adding a key.
#[must_use]
pub fn data(o: &Expr<Object>, key: &str) -> Expr<Str> {
    Expr::new(format!("{}.data[{}]", o, lit(key)))
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

/// `Ensure(path, field, value) -> effect`. Sets ONE key on a ConfigMap.
///
/// ***THE WRITE BOUNDARY IS FIELD-SCOPED FOR THIS ONE, AND A BARE PATH GRANTS
/// NOTHING.*** `spec.writes` must declare `path#field`. `spec.writes` is an
/// OBJECT boundary and was safe only because every verb was narrow - a declared
/// Deployment path granted "set one integer". A field-writing verb would, on the
/// same declaration, grant whatever that field is worth, and every path already
/// declared would gain it with no CR edited.
///
/// ConfigMap keys only: a key is inert data, where a pod-template field would be
/// arbitrary code execution under that workload's identity.
#[must_use]
pub fn ensure(path: &crate::path::ApiPath, field: &str, value: &str) -> Expr<Effect> {
    Expr::new(format!(
        "Ensure({}, {}, {})",
        lit(path.as_str()),
        lit(field),
        lit(value)
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
