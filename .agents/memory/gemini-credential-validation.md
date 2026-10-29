---
name: Gemini credential validation
description: A configured Gemini secret can still be rejected by Google's API.
---

Treat a green health check that only tests whether `GEMINI_API_KEY` exists as configuration presence, not proof that Gemini accepts the credential. Before claiming the model integration works, make a low-risk real model request and distinguish its result from local fallback processing.

**Why:** An invalid key was present in Replit Secrets, while the app's deterministic fallback still returned a successful case review.

**How to apply:** Verify Gemini with a non-creating request before delivery or deployment. Keep key values out of output and logs; use sanitized provider status details when diagnosing failures.
