---
id: example-build-missing-module
pattern: "Cannot open module file '[a-z_]+\\.mod'"
tools: [build]
compiler: example
machine: any
date: 2026-11-10
evidence: "an example lesson that ships with the template; delete it"
---
Cause: a module was compiled after a file that uses it, so its .mod file did not exist yet.
Workaround: build the module's source file first, or fix the order of sources in the build file.
