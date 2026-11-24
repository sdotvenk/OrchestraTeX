"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
  dividerBefore?: boolean;
  shortcut?: string;
  voiceColor?: string;
  active?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });

  // Adjust position when x/y props change, keeping menu within viewport

  useLayoutEffect(() => {
    if (!menuRef.current) {
      setPosition({ x, y });
      return;
    }

    const menu = menuRef.current;
    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let adjustedX = x;
    let adjustedY = y;

    // Check right edge
    if (x + rect.width > viewportWidth) {
      adjustedX = viewportWidth - rect.width - 8;
    }

    // Check bottom edge
    if (y + rect.height > viewportHeight) {
      adjustedY = viewportHeight - rect.height - 8;
    }

    // Ensure not negative
    adjustedX = Math.max(8, adjustedX);
    adjustedY = Math.max(8, adjustedY);

    setPosition({ x: adjustedX, y: adjustedY });
  }, [x, y]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  const handleItemClick = useCallback(
    (item: ContextMenuItem) => {
      if (!item.disabled) {
        item.onClick();
        onClose();
      }
    },
    [onClose],
  );

  const menu = (
    <AnimatePresence>
      <motion.div
        ref={menuRef}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.1 }}
        className="fixed z-50 min-w-[224px] ox-popover p-[5px] text-foreground"
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
        }}
      >
        <div role="menu">
          {items.map((item) => (
            <div key={item.label}>
              {item.dividerBefore && <div className="my-1 mx-1.5 h-px bg-border" />}
              <button
                type="button"
                role="menuitem"
                onClick={() => handleItemClick(item)}
                disabled={item.disabled}
                className={`w-full flex items-center gap-2 h-7 px-2.5 rounded-[6px] text-[12.5px] text-left transition-colors whitespace-nowrap ${
                  item.disabled
                    ? "opacity-50 cursor-not-allowed"
                    : item.active
                      ? "bg-primary text-primary-text"
                      : item.danger
                        ? "text-error hover:bg-error-bg/50"
                        : "hover:bg-subtle"
                }`}
              >
                {item.voiceColor && (
                  <span
                    className="size-[7px] rounded-full shrink-0"
                    style={{ backgroundColor: item.voiceColor }}
                    aria-hidden="true"
                  />
                )}
                {item.icon && (
                  <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                    {item.icon}
                  </span>
                )}
                <span className="truncate">{item.label}</span>
                {item.shortcut && (
                  <span
                    className={`ml-auto font-mono text-[11px] ${
                      item.active ? "text-primary-text/70" : "text-muted"
                    }`}
                  >
                    {item.shortcut}
                  </span>
                )}
              </button>
            </div>
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );

  if (typeof document === "undefined") return menu;
  return createPortal(menu, document.body);
}
