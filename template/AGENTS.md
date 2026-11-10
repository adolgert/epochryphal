## Harness
This project uses a harness: its configuration, check and procedure scripts, plans, lessons, and logs are under `harness/`.
A harness step is finished only when the `submit` tool passes; your own judgment that the work is done does not finish it.
If you cannot finish a step, call `report_blocked` with the reason instead of stopping.
Do not change files that match the `protected` patterns in `harness/harness.json`, or anything under `harness/plans/` or `harness/log/`.
