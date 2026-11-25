"use client";

import { CheckCircleIcon, InfoIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import type React from "react";
import { createContext, useCallback, useContext, useState } from "react";

type ToastType = "success" | "error" | "info";

type ToastAction = {
  label: string;
  onClick: () => void;
};

type Toast = {
  id: string;
  message: string;
  type: ToastType;
  action?: ToastAction;
};

type ToastContextType = {
  toast: (message: string, type?: ToastType, options?: { action?: ToastAction }) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback(
    (message: string, type: ToastType = "info", options?: { action?: ToastAction }) => {
      const id = Math.random().toString(36).substring(2, 9);
      const newToast: Toast = { id, message, type, action: options?.action };

      setToasts((prev) => [...prev.slice(-2), newToast]);

      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3600);
    },
    [],
  );

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
        <AnimatePresence>
          {toasts.map((t) => (
            <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const Icon = getIcon(toast.type);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8, scale: 0.97 }}
      transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
      className="pointer-events-auto"
    >
      <div
        className="bg-toast-bg text-toast-fg max-w-[440px] min-h-[38px] pl-3.5 pr-2 py-1.5 rounded-full flex items-center gap-2.5 border border-white/10"
        style={{ boxShadow: "var(--shadow-2)" }}
      >
        <div className="flex-shrink-0">{Icon}</div>
        <p className="text-[12.5px] leading-snug flex-1">{toast.message}</p>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.id);
            }}
            className="flex-shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-toast-fg hover:bg-white/10 transition-colors"
          >
            {toast.action.label}
          </button>
        )}
        <button
          type="button"
          onClick={() => onDismiss(toast.id)}
          className="flex-shrink-0 size-6 rounded-full inline-flex items-center justify-center text-toast-fg/70 hover:text-toast-fg hover:bg-white/10 transition-colors"
          aria-label="Dismiss"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    </motion.div>
  );
}

function getIcon(type: ToastType) {
  switch (type) {
    case "success":
      return <CheckCircleIcon size={16} weight="fill" className="text-emerald-400" />;
    case "error":
      return <WarningCircleIcon size={16} weight="fill" className="text-rose-400" />;
    case "info":
      return <InfoIcon size={16} weight="fill" className="text-sky-300" />;
  }
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}
