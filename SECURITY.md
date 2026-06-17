# Security Policy

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Report privately via one of:

- GitHub's [private vulnerability reporting](https://github.com/sidanclaw/sidanclaw/security/advisories/new) (preferred), or
- email **security@sidan.ai** with the details and reproduction steps.

We aim to acknowledge within **3 business days** and to provide a remediation
timeline after triage. Please give us a reasonable window to ship a fix before
any public disclosure; we will credit you in the advisory unless you prefer to
remain anonymous.

## Scope

This repository is the **open core** (`sidanclaw`) — the single-player local
brain: engine, brain/dreaming, canvas, and frontend, run locally on a model key.
The hosted multi-tenant platform is a separate, closed codebase; vulnerabilities
specific to the hosted service should still be reported through the channels
above and we will route them.

## Supported versions

Until a `1.0` release, security fixes land on `main` and the latest tagged
release only. Pin to a released tag for production use.
