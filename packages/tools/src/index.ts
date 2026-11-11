export * from "./types";
export * from "./registry";
export { calculatorTool, evaluateExpression } from "./builtin/calculator";
export { currentDateTimeTool } from "./builtin/datetime";
export { textTransformTool } from "./builtin/text";
export { jsonTransformTool, applyJsonOperations } from "./builtin/json";
export { mockExternalActionTool } from "./builtin/mockAction";

import { calculatorTool } from "./builtin/calculator";
import { currentDateTimeTool } from "./builtin/datetime";
import { jsonTransformTool } from "./builtin/json";
import { mockExternalActionTool } from "./builtin/mockAction";
import { textTransformTool } from "./builtin/text";
import { ToolRegistry } from "./registry";

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(calculatorTool)
    .register(currentDateTimeTool)
    .register(textTransformTool)
    .register(jsonTransformTool)
    .register(mockExternalActionTool);
}
