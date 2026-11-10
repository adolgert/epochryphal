# Harness report

12 step attempts, 2026-11-10T09:00:00.000Z to 2026-11-10T20:00:00.000Z.

## Per kind

| kind | attempts | passed | blocked | abandoned | stopped | completion | unaided | median tokens | median cost | median agent min | median checks |
|---|---|---|---|---|---|---|---|---|---|---|---|
| measure | 4 | 3 | 0 | 1 | 0 | 75% | 50% | 250000 | $2.50 | 25.0 | 1 |
| offload | 5 | 2 | 1 | 0 | 2 | 40% | 20% | 800000 | $9.41 | 38.2 | 3 |
| restructure | 3 | 1 | 1 | 0 | 1 | 33% | 0% | 600000 | $7.25 | 50.5 | 2 |

## Interruptions

| kind | total | wrong-direction | missing-info | environment | too-slow | other | unlabeled |
|---|---|---|---|---|---|---|---|
| measure | 3 | 0 | 1 | 0 | 0 | 0 | 2 |
| offload | 5 | 1 | 0 | 1 | 1 | 1 | 1 |
| restructure | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| all | 10 | 1 | 3 | 1 | 1 | 1 | 3 |

## Stop rules

| rule | count |
|---|---|
| budget_tokens | 2 |
| stall | 1 |

## Per plan

| plan | steps | from proposals | proposals accepted | proposals rejected | decision |
|---|---|---|---|---|---|
| e1 | 5 | 2 | 2 | 1 | keep |
| e2 | 5 | 0 | 0 | 0 | open |
