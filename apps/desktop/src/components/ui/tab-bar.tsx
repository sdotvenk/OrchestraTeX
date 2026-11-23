"use client";

import {
  CaretLineLeftIcon,
  CaretLineRightIcon,
  TrashIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ContextMenu, type ContextMenuItem } from "./context-menu";

export interface TabItem {
  id: string;
  label: string;
  title?: string;
  badge?: string | number;
}

export type TabReorderPosition = "before" | "after";

type TabDropIndicator = {
  tabId: string;
  position: TabReorderPosition;
};

export type TabDragEndPayload = {
  tabId: string;
  clientX: number;
  clientY: number;
  dropTarget:
    | { type: "tab"; tabId: string; position: TabReorderPosition }
    | { type: "outside" }
    | { type: "none" };
};

export type TabDragMovePayload = {
  tabId: string;
  clientX: number;
  clientY: number;
};

export interface TabBarProps<T extends TabItem> {
  tabs: T[];
  activeTab: string;
  onTabSelect: (id: string) => void;
  onTabClose?: (id: string) => void;
  onTabReorder?: (draggedId: string, targetId: string, position: TabReorderPosition) => void;
  onTabDragMove?: (payload: TabDragMovePayload | null) => void;
  onTabDragEnd?: (payload: TabDragEndPayload) => void;
  onCloseOthers?: (id: string) => void;
  onCloseToLeft?: (id: string) => void;
  onCloseToRight?: (id: string) => void;
  onCloseAll?: () => void;
  variant?: "sidebar" | "editor";
  className?: string;
}

type DragState = {
  isDragging: boolean;
  draggedTabId: string | null;
  draggedTabLabel: string | null;
  mouseX: number;
  mouseY: number;
  dropIndicator: TabDropIndicator | null;
};

const DRAG_THRESHOLD_PX = 6;

const initialDragState: DragState = {
  isDragging: false,
  draggedTabId: null,
  draggedTabLabel: null,
  mouseX: 0,
  mouseY: 0,
  dropIndicator: null,
};

export function TabBar<T extends TabItem>({
  tabs,
  activeTab,
  onTabSelect,
  onTabClose,
  onTabReorder,
  onTabDragMove,
  onTabDragEnd,
  onCloseOthers,
  onCloseToLeft,
  onCloseToRight,
  onCloseAll,
  variant = "editor",
  className = "",
}: TabBarProps<T>) {
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    tabId: string;
  } | null>(null);
  const [dragState, setDragState] = useState<DragState>(initialDragState);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const draggedTabIdRef = useRef<string | null>(null);
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const dropIndicatorRef = useRef<TabDropIndicator | null>(null);
  const isDraggingRef = useRef(false);
  const suppressTabClickRef = useRef(false);
  const handleMouseMoveRef = useRef<((e: MouseEvent) => void) | null>(null);
  const handleMouseUpRef = useRef<((e: MouseEvent) => void) | null>(null);

  const tabLabelById = useMemo(() => {
    const labelMap = new Map<string, string>();
    for (const tab of tabs) {
      labelMap.set(tab.id, tab.label);
    }
    return labelMap;
  }, [tabs]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      if (e.button === 1 && onTabClose) {
        e.preventDefault();
        onTabClose(tabId);
      }
    },
    [onTabClose],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      if (onTabClose) {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, tabId });
      }
    },
    [onTabClose],
  );

  const getContextMenuItems = useCallback(
    (tabId: string): ContextMenuItem[] => {
      const tabIndex = tabs.findIndex((t) => t.id === tabId);
      const items: ContextMenuItem[] = [];

      if (onTabClose) {
        items.push({
          label: "Close",
          onClick: () => onTabClose(tabId),
          icon: <XIcon className="w-4 h-4" />,
        });
      }

      if (onCloseOthers) {
        items.push({
          label: "Close Others",
          onClick: () => onCloseOthers(tabId),
          disabled: tabs.length <= 1,
          icon: <XCircleIcon className="w-4 h-4" />,
        });
      }

      if (onCloseToLeft) {
        items.push({
          label: "Close to the Left",
          onClick: () => onCloseToLeft(tabId),
          disabled: tabIndex === 0,
          icon: <CaretLineLeftIcon className="w-4 h-4" />,
        });
      }

      if (onCloseToRight) {
        items.push({
          label: "Close to the Right",
          onClick: () => onCloseToRight(tabId),
          disabled: tabIndex === tabs.length - 1,
          icon: <CaretLineRightIcon className="w-4 h-4" />,
        });
      }

      if (onCloseAll) {
        items.push({
          label: "Close All",
          onClick: onCloseAll,
          danger: true,
          icon: <TrashIcon className="w-4 h-4" />,
        });
      }

      return items;
    },
    [tabs, onTabClose, onCloseOthers, onCloseToLeft, onCloseToRight, onCloseAll],
  );

  const clearDocumentDragListeners = useCallback(() => {
    if (handleMouseMoveRef.current) {
      document.removeEventListener("mousemove", handleMouseMoveRef.current);
      handleMouseMoveRef.current = null;
    }
    if (handleMouseUpRef.current) {
      document.removeEventListener("mouseup", handleMouseUpRef.current);
      handleMouseUpRef.current = null;
    }
  }, []);

  const resetDragState = useCallback(() => {
    clearDocumentDragListeners();
    draggedTabIdRef.current = null;
    dragStartPosRef.current = null;
    dropIndicatorRef.current = null;
    isDraggingRef.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setDragState(initialDragState);
    onTabDragMove?.(null);
  }, [clearDocumentDragListeners, onTabDragMove]);

  useEffect(() => {
    return () => {
      resetDragState();
    };
  }, [resetDragState]);

  const setTabRef = useCallback((tabId: string, element: HTMLDivElement | null) => {
    if (element) {
      tabRefs.current.set(tabId, element);
      return;
    }
    tabRefs.current.delete(tabId);
  }, []);

  const isPointInsideContainer = useCallback((x: number, y: number): boolean => {
    const container = containerRef.current;
    if (!container) return false;
    const rect = container.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }, []);

  const findDropIndicator = useCallback(
    (pointerX: number, pointerY: number, draggedTabId: string): TabDropIndicator | null => {
      if (!isPointInsideContainer(pointerX, pointerY)) return null;

      const availableTabs = tabs.filter((tab) => tab.id !== draggedTabId);
      if (availableTabs.length === 0) return null;

      let candidate: TabDropIndicator | null = null;
      for (const tab of availableTabs) {
        const tabElement = tabRefs.current.get(tab.id);
        if (!tabElement) continue;
        const rect = tabElement.getBoundingClientRect();
        if (pointerX < rect.left + rect.width / 2) {
          return { tabId: tab.id, position: "before" };
        }
        candidate = { tabId: tab.id, position: "after" };
      }
      return candidate;
    },
    [tabs, isPointInsideContainer],
  );

  const handleDocumentMouseMove = useCallback(
    (e: MouseEvent) => {
      const draggedTabId = draggedTabIdRef.current;
      const dragStartPos = dragStartPosRef.current;
      if (!draggedTabId || !dragStartPos) return;

      if (!isDraggingRef.current) {
        const dx = e.clientX - dragStartPos.x;
        const dy = e.clientY - dragStartPos.y;
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD_PX) return;
        isDraggingRef.current = true;
      }

      const indicator = findDropIndicator(e.clientX, e.clientY, draggedTabId);
      dropIndicatorRef.current = indicator;

      setDragState((prev) => ({
        ...prev,
        isDragging: true,
        mouseX: e.clientX,
        mouseY: e.clientY,
        dropIndicator: indicator,
      }));

      onTabDragMove?.({
        tabId: draggedTabId,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    },
    [findDropIndicator, onTabDragMove],
  );

  const handleDocumentMouseUp = useCallback(
    (e: MouseEvent) => {
      const draggedTabId = draggedTabIdRef.current;
      const dropIndicator = dropIndicatorRef.current;
      const wasDragging = isDraggingRef.current;

      let didReorder = false;
      if (
        wasDragging &&
        draggedTabId &&
        dropIndicator &&
        dropIndicator.tabId !== draggedTabId &&
        onTabReorder
      ) {
        onTabReorder(draggedTabId, dropIndicator.tabId, dropIndicator.position);
        didReorder = true;
      }

      if (wasDragging && draggedTabId) {
        const dropTarget: TabDragEndPayload["dropTarget"] =
          dropIndicator && dropIndicator.tabId !== draggedTabId
            ? {
                type: "tab",
                tabId: dropIndicator.tabId,
                position: dropIndicator.position,
              }
            : isPointInsideContainer(e.clientX, e.clientY)
              ? { type: "none" }
              : { type: "outside" };

        onTabDragEnd?.({
          tabId: draggedTabId,
          clientX: e.clientX,
          clientY: e.clientY,
          dropTarget,
        });

        if (didReorder || dropTarget.type === "none") {
          suppressTabClickRef.current = true;
          window.setTimeout(() => {
            suppressTabClickRef.current = false;
          }, 0);
        }
      }

      resetDragState();
    },
    [onTabReorder, onTabDragEnd, isPointInsideContainer, resetDragState],
  );

  const handleTabPointerDown = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      if (!onTabReorder) return;
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-tab-close='true']")) return;

      resetDragState();
      e.preventDefault();

      draggedTabIdRef.current = tabId;
      dragStartPosRef.current = { x: e.clientX, y: e.clientY };
      isDraggingRef.current = false;
      dropIndicatorRef.current = null;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";

      setDragState({
        isDragging: false,
        draggedTabId: tabId,
        draggedTabLabel: tabLabelById.get(tabId) ?? tabId,
        mouseX: e.clientX,
        mouseY: e.clientY,
        dropIndicator: null,
      });

      handleMouseMoveRef.current = handleDocumentMouseMove;
      handleMouseUpRef.current = handleDocumentMouseUp;
      document.addEventListener("mousemove", handleDocumentMouseMove);
      document.addEventListener("mouseup", handleDocumentMouseUp);
    },
    [onTabReorder, resetDragState, tabLabelById, handleDocumentMouseMove, handleDocumentMouseUp],
  );

  const handleTabClick = useCallback(
    (tabId: string) => {
      if (suppressTabClickRef.current) return;
      onTabSelect(tabId);
    },
    [onTabSelect],
  );

  if (variant === "sidebar") {
    return (
      <div className={`px-2 pt-1.5 pb-1 ${className}`}>
        <div className="flex items-center p-0.5 rounded-lg bg-sunken gap-0.5">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab;
            return (
              <button
                type="button"
                key={tab.id}
                onClick={() => onTabSelect(tab.id)}
                className={`flex-1 h-7 px-2 rounded-md text-[12px] font-medium transition-all flex items-center justify-center gap-1.5 ${
                  isActive
                    ? "bg-panel text-foreground-strong shadow-xs"
                    : "text-muted hover:text-foreground"
                }`}
              >
                <span>{tab.label}</span>
                {tab.badge !== undefined && (
                  <span
                    className={`text-[10.5px] px-1.5 py-0.2 rounded-full font-mono tabular-nums ${
                      isActive ? "bg-accent-soft text-accent" : "bg-subtle text-muted"
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const dropTargetLabel = dragState.dropIndicator
    ? (tabLabelById.get(dragState.dropIndicator.tabId) ?? dragState.dropIndicator.tabId)
    : null;

  return (
    <>
      <div
        ref={containerRef}
        className={`flex items-center gap-0.5 px-2 border-b border-border bg-panel overflow-x-auto min-h-[36px] ${className}`}
        style={{
          cursor: onTabReorder && dragState.isDragging ? "grabbing" : undefined,
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          const isDragged = dragState.isDragging && dragState.draggedTabId === tab.id;
          const showDropBefore =
            dragState.dropIndicator?.tabId === tab.id &&
            dragState.dropIndicator.position === "before";
          const showDropAfter =
            dragState.dropIndicator?.tabId === tab.id &&
            dragState.dropIndicator.position === "after";

          return (
            <div
              key={tab.id}
              ref={(node) => setTabRef(tab.id, node)}
              data-tab-id={tab.id}
              className={`group relative flex items-center h-[36px] transition-colors select-none border-b-2 -mb-px ${
                isActive
                  ? "border-accent text-accent"
                  : "border-transparent text-muted hover:text-foreground"
              } ${onTabReorder ? "cursor-grab" : ""} ${isDragged ? "opacity-40" : ""}`}
              title={tab.title ?? tab.label}
            >
              {showDropBefore && (
                <div className="pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent z-10" />
              )}
              <button
                type="button"
                onMouseDown={(e) => {
                  handleMouseDown(e, tab.id);
                  handleTabPointerDown(e, tab.id);
                }}
                onContextMenu={(e) => handleContextMenu(e, tab.id)}
                onClick={() => handleTabClick(tab.id)}
                className={`pl-2.5 pr-1.5 py-1 text-[12px] font-mono truncate max-w-[156px] ${
                  isActive ? "font-medium" : "font-normal"
                }`}
              >
                {tab.label}
              </button>
              {onTabClose && (
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTabClose(tab.id);
                  }}
                  data-tab-close="true"
                  className={`size-5 mr-1 rounded-md flex items-center justify-center hover:bg-subtle transition-opacity ${
                    isActive ? "opacity-75 hover:opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                  aria-label="Close tab"
                >
                  <XIcon className="w-3 h-3" />
                </button>
              )}
              {showDropAfter && (
                <div className="pointer-events-none absolute right-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent z-10" />
              )}
            </div>
          );
        })}
      </div>

      {dragState.isDragging &&
        dragState.draggedTabLabel &&
        createPortal(
          <div
            className="fixed pointer-events-none z-[9999] flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border-dark bg-panel text-xs font-mono shadow-md"
            style={{
              left: dragState.mouseX + 14,
              top: dragState.mouseY + 14,
            }}
          >
            <span className="truncate max-w-[220px]">{dragState.draggedTabLabel}</span>
            {dropTargetLabel && (
              <span className="text-muted whitespace-nowrap">-&gt; {dropTargetLabel}</span>
            )}
          </div>,
          document.body,
        )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={getContextMenuItems(contextMenu.tabId)}
        />
      )}
    </>
  );
}
