import type { FileNode } from "@orchestratex/shared";
import type { AttachmentInput } from "@/lib/agent/types";

export function formatTokenCount(count: number | null | undefined): string {
  if (count == null || !Number.isFinite(count)) return "0";
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 1 : 2)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(count >= 100_000 ? 0 : 1)}K`;
  }
  return String(Math.round(count));
}

export function formatCostUsd(cost: number | null | undefined): string {
  if (cost == null || !Number.isFinite(cost)) return "$0.00";
  if (cost === 0) return "$0.00";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function formatRelativeTime(timestampMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 45) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(timestampMs).toLocaleDateString();
}

export function formatResetCountdown(resetsAt: number | null | undefined): string | null {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return null;
  // Heuristic: seconds vs milliseconds epoch
  const targetMs = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
  const diffMs = targetMs - Date.now();
  if (diffMs <= 0) return "now";
  const totalMin = Math.ceil(diffMs / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) {
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function flattenFileNodes(nodes: FileNode[], projectRoot?: string | null): string[] {
  const results: string[] = [];
  const normRoot = projectRoot ? projectRoot.replace(/\\/g, "/").replace(/\/+$/, "") : null;

  const visit = (list: FileNode[]) => {
    for (const node of list) {
      if (node.type === "file") {
        const normalized = node.path.replace(/\\/g, "/");
        if (normRoot && normalized.startsWith(`${normRoot}/`)) {
          results.push(normalized.slice(normRoot.length + 1));
        } else {
          results.push(normalized);
        }
      }
      if (node.children && node.children.length > 0) {
        visit(node.children);
      }
    }
  };

  visit(nodes);
  return results;
}

export function toRelativeProjectPath(filePath: string, projectRoot?: string | null): string {
  const norm = filePath.replace(/\\/g, "/");
  if (!projectRoot) return norm;
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm.startsWith(`${root}/`)) {
    return norm.slice(root.length + 1);
  }
  return norm;
}

export async function fileToAttachmentInput(file: File): Promise<AttachmentInput> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read file as Data URL"));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(file);
  });

  return {
    dataUrl,
    mime: file.type || "image/png",
    filename: file.name || `image-${Date.now()}.png`,
  };
}
