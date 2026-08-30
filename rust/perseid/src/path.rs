// Copyright (C) 2025-2026 Malformed C. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

//! Canonical apiserver paths, BUILT rather than typed.
//!
//! ```
//! let p = perseid::path::ns("default").deployments("api");
//! assert_eq!(p.as_str(), "/apis/apps/v1/namespaces/default/deployments/api");
//! ```
//!
//! # Why a builder is the only constructor
//!
//! `ApiPath` has no public constructor from a string, so a hand-written one is
//! not merely discouraged - it does not exist. The segments cannot be
//! mis-ordered, a separator cannot be doubled, and the `namespaces` segment
//! cannot be forgotten.
//!
//! That is not fussiness about strings. The reconcile contract has already paid
//! for this once: a field NAME was passed where a path goes, the host answered
//! `unknown` on every pass for four days, and nothing reported it - a read
//! outside the grant is ABSENT rather than an error, so a malformed path is
//! indistinguishable from an object that is not there.
//!
//! The NAMESPACE being an argument is not a contradiction. The grant still
//! decides what a program may reach: `spec.writes` gates every obligation and a
//! read outside the grant returns absent. What the builder removes is the class
//! of error where a program meant a legal object and produced a differently
//! shaped string for it.

use core::fmt;

/// A canonical apiserver path.
///
/// Constructed only through [`ns`].
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ApiPath(String);

impl ApiPath {
    /// The path text.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ApiPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Scope to a namespace.
#[must_use]
pub fn ns(namespace: &str) -> Namespaced<'_> {
    Namespaced { namespace }
}

/// A namespace scope, from [`ns`].
#[derive(Debug, Clone, Copy)]
pub struct Namespaced<'a> {
    namespace: &'a str,
}

impl Namespaced<'_> {
    /// `/apis/apps/v1/namespaces/NS/deployments/NAME` - what `scale` writes.
    #[must_use]
    pub fn deployments(self, name: &str) -> ApiPath {
        ApiPath(format!(
            "/apis/apps/v1/namespaces/{}/deployments/{}",
            self.namespace, name
        ))
    }

    /// `/api/v1/namespaces/NS/pods/NAME`.
    #[must_use]
    pub fn pods(self, name: &str) -> ApiPath {
        ApiPath(format!(
            "/api/v1/namespaces/{}/pods/{}",
            self.namespace, name
        ))
    }

    /// An arbitrary namespaced resource, for a kind with no named helper.
    ///
    /// Still a builder: the group/version/resource ORDER is the thing that goes
    /// wrong, and this fixes it even where the kind is open.
    #[must_use]
    pub fn resource(self, group: &str, version: &str, resource: &str, name: &str) -> ApiPath {
        ApiPath(format!(
            "/apis/{}/{}/namespaces/{}/{}/{}",
            group, version, self.namespace, resource, name
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_canonical_shapes() {
        assert_eq!(
            ns("default").deployments("api").as_str(),
            "/apis/apps/v1/namespaces/default/deployments/api"
        );
        // A POD path is /api/v1, not /apis/... - the core group has no `apis`
        // segment, and getting that wrong is a path that 404s rather than one
        // that fails to parse.
        assert_eq!(
            ns("default").pods("api-7d9f").as_str(),
            "/api/v1/namespaces/default/pods/api-7d9f"
        );
        assert_eq!(
            ns("kube-system")
                .resource("apps", "v1", "daemonsets", "kube-proxy")
                .as_str(),
            "/apis/apps/v1/namespaces/kube-system/daemonsets/kube-proxy"
        );
    }
}
