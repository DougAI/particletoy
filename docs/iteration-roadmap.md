# Mobile iteration roadmap

This iteration focused on making the static, no-build-step editor practical on phones
and tablets. Each milestone was shipped with a focused automated or browser-level check.

1. **Workspace navigation** — switch between full-size Preview, Inspect, and Code views
   on narrow screens without disturbing the desktop split layout. **Complete.**
2. **Compact command bar** — keep playback and primary save/share actions reachable while
   moving infrequent commands into an overflow sheet. **Complete.**
3. **Touch camera controls** — support one-finger orbit plus two-finger pan and zoom
   without fighting page gestures. **Complete.**
4. **Touch-sized inspector** — enlarge targets, reflow property rows, and keep numeric
   controls usable with the software keyboard open. **Complete.**
5. **Precision curve editing** — add selection, nudge, and delete affordances that do not
   depend on hover or right-click. **Complete.**
6. **Responsive dialogs** — make library, publish, import, export, and help flows fit safe
   areas and small landscape screens. **Complete.**
7. **Adaptive render quality** — scale resolution and expensive effects against measured
   frame time, with a manual override. **Complete.**
8. **Installable/offline shell** — add a manifest and conservative service worker for the
   static editor shell while keeping shared and published data network-aware. **Complete.**
