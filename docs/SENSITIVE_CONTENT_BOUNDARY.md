# Sensitive-Content Boundary Enforcement & Tests (#241)

## Overview
Securing sensitive content across rendering pipelines, file downloads, outbound webhooks, and data exports is vital to prevent Cross-Site Scripting (XSS), Server-Side Request Forgery (SSRF), formula injection (CWE-1236), cross-tenant leakage, and inadvertent disclosure of credentials and PII.

The `SensitiveContentBoundaryService` and test suite enforce clear security perimeters across four core domains:

### 1. Rendering Boundary
- **Plain Text Rendering**: Automatically escapes HTML control characters (`&`, `<`, `>`, `"`, `'`, `/`) to prevent stored and reflected XSS.
- **Rich Text Rendering**: Sanitizes input by recursively stripping dangerous HTML elements (`<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<applet>`, `<meta>`, `<svg>`), DOM event handlers (`onerror`, `onclick`, `onload`), and pseudo-protocol URIs (`javascript:`).
- **Nested Tag Neutralization**: Loops sanitization passes to defeat nested-tag evasion attacks (e.g., `<<script>script>`).

### 2. Download Boundary
- **Tenant & Role ACL Authorization**: Verifies user tenancy and role authorizations before granting access to binary streams, preventing cross-tenant document exposure.
- **Path Traversal & CRLF Prevention**: Sanitizes requested filenames by stripping path traversal delimiters (`..`, `/`, `\`) and control/line-feed characters (`\r`, `\n`) to prevent HTTP response splitting.
- **Defensive HTTP Headers**: Automatically sets:
  - `Content-Disposition: attachment; filename="sanitized_name.ext"`
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: no-store, no-cache, must-revalidate, private`
  - `X-Frame-Options: DENY`

### 3. Webhook Boundary
- **SSRF Defense**: Validates destination URLs and strictly blocks localhost (`127.0.0.1`, `::1`), cloud metadata endpoints (`169.254.169.254`), and private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`).
- **Secret & Credential Scrubbing**: Recursively sanitizes webhook payloads to remove private cryptographic keys, seeds, passwords, auth tokens, salts, and SSNs.
- **Cryptographic Signatures**: Signs outgoing webhook payloads using HMAC-SHA256, providing an `X-Trellis-Signature` header for receiver authentication.

### 4. Export Boundary (CSV, JSON, Reports)
- **Formula Injection (CWE-1236) Defense**: Neutralizes cells beginning with `=`, `+`, `-`, `@`, `\t`, or `\r` by prefixing a single quote `'` to prevent remote command execution in spreadsheets.
- **PII Scrubbing & Masking**: Masks email addresses (e.g. `u***@d***.com`) and Tax IDs / SSNs (`***-**-1234`).
- **Credential Stripping**: Automatically strips authentication secrets (`passwordHash`, `salt`, `token`) from exported rows.

## Architecture & Tests
- `src/security/sensitive-content-boundary.service.ts`: Security boundary enforcement utility.
- `src/security/sensitive-content-boundary.spec.ts`: Unit test suite covering all four boundary domains.
