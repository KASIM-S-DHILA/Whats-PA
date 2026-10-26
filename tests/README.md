# Tests

`current.test.mjs` is the default offline acceptance gate run by `npm test`. It covers active module loading, owner configuration, PDF follow-up and rephrase limits, command parsing, safe example configuration/secrets and migration order.

The `*.historical.mjs` files are pre-`chat-recovery-v1` suites retained for review only. They target older modules and are not expected to pass against the current source. They are not run by `npm test`.

Do not add live customer data, credentials or synthetic live traffic to any test.
