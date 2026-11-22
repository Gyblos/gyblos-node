# Architecture decision records

This directory records durable engineering decisions that should not live only
in source comments. Current behavior and contracts remain in their owning
documentation and code.

| ADR                                               | Decision                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| [0001](0001-model-reasoning-support.md)           | Expose only verified model reasoning modes and conservative defaults. |
| [0002](0002-observation-upload-default.md)        | Enable content-free observations by default with an explicit opt-out. |
| [0003](0003-identity-sponsorship-online-check.md) | Keep identity sponsorship unwired until its online check is real.     |
| [0004](0004-buyer-theme-surfaces.md)              | Give buyer messages and supporting labels distinct visual contrast.   |
| [0005](0005-desktop-update-policy.md)             | The desktop host opens releases but never installs code.              |
