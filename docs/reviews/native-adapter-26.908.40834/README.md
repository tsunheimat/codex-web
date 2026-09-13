# Optional Desktop compatibility patch — review artifacts

This is an unapplied proposal for Desktop 26.908.40834; it is not a required dependency of the unmodified-Desktop bridge. See [the route analysis and review](../../native-adapter-review.md).

- [installed-files.diff](installed-files.diff) contains every proposed changed hunk and added module. Both sides are formatted with Prettier 3.8.2 to avoid publishing entire minified vendor bundles. **This is a review diff, not a patch to apply directly to the installed minified files.**
- [edits.json](edits.json) is the exact hash-pinned edit recipe, including complete contents of the six added modules. It is the machine-readable representation of the proposal.
- [manifest.json](manifest.json) records raw and normalized component hashes, archive hashes and the frozen local approval-plan hash. No account credentials or machine-specific user paths are included.

The original/proposed ASAR binaries and local approval file are not published. Applying anything to Desktop still requires separate approval, a matching installed package, and the documented rollback procedure. This publication does not grant installation approval.
