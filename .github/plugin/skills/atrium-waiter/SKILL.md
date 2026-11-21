---
name: atrium-waiter
description: Use when Atrium.run or an Atrium search returns operationId and operation-wait. Delegates the bounded wait to the atrium-waiter subagent and preserves pull reattachment.
---

# Atrium waiter

For an Atrium `running` or `continue` handoff:

1. Start one background `atrium-waiter` subagent.
2. Give it operationId, resultPath, objective, expected result, and observation budget.
3. Return to independent parent work.
4. Consume task completion once through the normal Copilot handoff.
5. Never poll Atrium or reexecute the original command from the parent.
6. If the waiter disappears or expires, reattach with operationId and operation-wait.
7. Use resultPath only for terminal replay or snapshot inspection.
