"use client";

import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as React from "react";

interface SwitchProps extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  className?: string;
}

/** Pill toggle matching the PDF toolbar's Auto switch. */
export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  SwitchProps
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={`
      peer relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full
      transition-colors
      focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-panel
      disabled:cursor-not-allowed disabled:opacity-50
      data-[state=checked]:bg-primary
      data-[state=unchecked]:bg-border-dark
      ${className ?? ""}
    `.trim()}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={`
        pointer-events-none block size-3 rounded-full bg-panel shadow-sm transition-transform
        data-[state=checked]:translate-x-[17px]
        data-[state=unchecked]:translate-x-[3px]
      `.trim()}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";
