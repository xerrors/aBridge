import { z } from "zod";
const modifierSchema = z.enum([
  "cmd",
  "command",
  "ctrl",
  "control",
  "alt",
  "option",
  "shift",
  "fn",
  "win",
  "meta",
]);
const coordinateSchema = z.number().finite().nonnegative();
const coordinateSpaceSchema = z.enum(["screenshot_pixels", "normalized_1000"]);
const elementRefSchema = z.string().min(1).max(100);
const clickSchema = z
  .object({
    type: z.enum(["click", "double_click"]),
    mode: z.literal("foreground").optional(),
    element_ref: elementRefSchema.optional(),
    x: coordinateSchema.optional(),
    y: coordinateSchema.optional(),
    coordinate_space: coordinateSpaceSchema.optional(),
    button: z.enum(["left", "right", "middle"]).default("left"),
    modifiers: z.array(modifierSchema).default([]),
  })
  .strict()
  .refine(
    (a) =>
      a.element_ref !== undefined
        ? a.x === undefined && a.y === undefined && a.coordinate_space === undefined
        : a.x !== undefined && a.y !== undefined,
    "Use element_ref or both screenshot coordinates",
  );
const typeSchema = z
  .object({
    type: z.literal("type"),
    text: z.string().max(10000),
    element_ref: elementRefSchema.optional(),
  })
  .strict();
const keySchema = z
  .object({
    type: z.literal("key"),
    key: z.string().min(1).max(100),
    modifiers: z.array(modifierSchema).default([]),
  })
  .strict();
const moveSchema = z
  .object({
    type: z.literal("move"),
    x: coordinateSchema,
    y: coordinateSchema,
    coordinate_space: coordinateSpaceSchema.optional(),
  })
  .strict();
const dragSchema = z
  .object({
    type: z.literal("drag"),
    x: coordinateSchema,
    y: coordinateSchema,
    to_x: coordinateSchema,
    to_y: coordinateSchema,
    coordinate_space: coordinateSpaceSchema.optional(),
  })
  .strict();
const scrollSchema = z
  .object({
    type: z.literal("scroll"),
    delta_y: z
      .number()
      .finite()
      .min(-10000)
      .max(10000)
      .describe(
        "Vertical wheel amount, not pixels: +40 is one tick down, -40 one tick up. Only one axis may be nonzero.",
      ),
    delta_x: z
      .number()
      .finite()
      .min(-10000)
      .max(10000)
      .default(0)
      .describe(
        "Horizontal wheel amount, not pixels: +40 is one tick right, -40 one tick left. Only one axis may be nonzero.",
      ),
    x: coordinateSchema
      .optional()
      .describe(
        "Optional scroll location in the latest screenshot; provide both x and y. Omit both to use the window center.",
      ),
    y: coordinateSchema
      .optional()
      .describe("Optional scroll location in the latest screenshot; provide both x and y."),
    coordinate_space: coordinateSpaceSchema
      .optional()
      .describe(
        "Coordinates default to screenshot_pixels; normalized_1000 explicitly maps 0–1000 into the latest screenshot. Requires x and y.",
      ),
  })
  .strict()
  .refine(
    (a) =>
      a.x === undefined && a.y === undefined
        ? a.coordinate_space === undefined
        : a.x !== undefined && a.y !== undefined,
    "Use both screenshot coordinates or omit both for center scrolling",
  )
  .refine((a) => Boolean(a.delta_x) !== Boolean(a.delta_y), "Scroll requires one nonzero axis");
export const windowsComputerActionSchema = z.discriminatedUnion("type", [
  clickSchema,
  typeSchema,
  keySchema,
  moveSchema,
  dragSchema,
  scrollSchema,
]);

export type WindowsComputerAction = z.infer<typeof windowsComputerActionSchema>;
