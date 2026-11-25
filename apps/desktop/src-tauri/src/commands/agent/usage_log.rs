use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use super::types::{now_millis, AgentProviderId};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageLogEntry {
    pub timestamp_ms: i64,
    pub project_path: String,
    pub thread_id: String,
    pub provider: AgentProviderId,
    pub model: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dedup_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
    /// True cache share computed only over entries that report both `cache_read_tokens` and `input_tokens`.
    pub cache_share: Option<f64>,
    /// Hit rate requires request-level counts; always `None` when only aggregated/cumulative counts are known.
    pub hit_rate: Option<f64>,
    pub threads_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreakdownRow {
    pub provider: AgentProviderId,
    pub model: Option<String>,
    pub summary: UsageSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageDailyRow {
    /// UTC date string `YYYY-MM-DD`.
    pub date: String,
    pub provider: AgentProviderId,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageProviderRow {
    pub provider: AgentProviderId,
    pub summary: UsageSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageThreadRow {
    pub thread_id: String,
    pub project_path: String,
    pub provider: AgentProviderId,
    pub summary: UsageSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageLogQueryResult {
    pub total: UsageSummary,
    pub by_provider: Vec<UsageProviderRow>,
    pub by_provider_model: Vec<UsageBreakdownRow>,
    pub by_day: Vec<UsageDailyRow>,
    pub top_threads: Vec<UsageThreadRow>,
    pub entry_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexCumulativeState {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct AcpLastSnapshot {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_write_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
}

pub struct UsageLogStore {
    path: PathBuf,
    loaded: Mutex<bool>,
    io_lock: Mutex<()>,
    seen_dedup_keys: Mutex<HashSet<String>>,
    codex_totals: Mutex<HashMap<String, CodexCumulativeState>>,
    acp_last: Mutex<HashMap<String, AcpLastSnapshot>>,
}

impl UsageLogStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            loaded: Mutex::new(false),
            io_lock: Mutex::new(()),
            seen_dedup_keys: Mutex::new(HashSet::new()),
            codex_totals: Mutex::new(HashMap::new()),
            acp_last: Mutex::new(HashMap::new()),
        }
    }

    fn watermark_path(&self) -> PathBuf {
        self.path.with_file_name("codex_watermarks.json")
    }

    async fn ensure_loaded(&self) -> Result<(), String> {
        let mut loaded = self.loaded.lock().await;
        if *loaded {
            return Ok(());
        }
        let _io = self.io_lock.lock().await;
        if let Ok(content) = fs::read_to_string(&self.path).await {
            let mut seen = self.seen_dedup_keys.lock().await;
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(entry) = serde_json::from_str::<UsageLogEntry>(trimmed) {
                    if let Some(key) = entry.dedup_key {
                        seen.insert(key);
                    }
                }
            }
        }
        let wm_path = self.watermark_path();
        if let Ok(wm_content) = fs::read_to_string(&wm_path).await {
            if let Ok(map) =
                serde_json::from_str::<HashMap<String, CodexCumulativeState>>(&wm_content)
            {
                let mut totals = self.codex_totals.lock().await;
                for (k, v) in map {
                    totals.entry(k).or_insert(v);
                }
            }
        }
        *loaded = true;
        Ok(())
    }

    async fn persist_watermarks(&self) -> Result<(), String> {
        let wm_path = self.watermark_path();
        let snapshot = {
            let totals = self.codex_totals.lock().await;
            serde_json::to_string(&*totals)
                .map_err(|e| format!("Failed to serialize codex watermarks: {e}"))?
        };
        let _io = self.io_lock.lock().await;
        if let Some(parent) = wm_path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create watermark dir: {e}"))?;
        }
        fs::write(&wm_path, snapshot.as_bytes())
            .await
            .map_err(|e| format!("Failed to write codex watermarks: {e}"))?;
        Ok(())
    }

    async fn append_entries(&self, entries: &[UsageLogEntry]) -> Result<(), String> {
        if entries.is_empty() {
            return Ok(());
        }
        self.ensure_loaded().await?;

        let _guard = self.io_lock.lock().await;
        let to_write: Vec<&UsageLogEntry> = {
            let seen = self.seen_dedup_keys.lock().await;
            entries
                .iter()
                .filter(|entry| match &entry.dedup_key {
                    Some(key) => !seen.contains(key),
                    None => true,
                })
                .collect()
        };
        if to_write.is_empty() {
            return Ok(());
        }

        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("Failed to create usage log dir: {e}"))?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .await
            .map_err(|e| format!("Failed to open usage log: {e}"))?;

        let mut buf = String::new();
        for entry in &to_write {
            let line = serde_json::to_string(entry)
                .map_err(|e| format!("Failed to serialize usage log entry: {e}"))?;
            buf.push_str(&line);
            buf.push('\n');
        }
        file.write_all(buf.as_bytes())
            .await
            .map_err(|e| format!("Failed to write usage log: {e}"))?;
        file.flush()
            .await
            .map_err(|e| format!("Failed to flush usage log: {e}"))?;

        let mut seen = self.seen_dedup_keys.lock().await;
        for entry in to_write {
            if let Some(ref key) = entry.dedup_key {
                seen.insert(key.clone());
            }
        }
        Ok(())
    }

    pub async fn record_claude_result(
        &self,
        project_path: &str,
        thread_id: &str,
        fallback_model: Option<&str>,
        result_val: &Value,
    ) -> Result<(), String> {
        let entries = normalize_claude_result_entries(
            now_millis(),
            project_path,
            thread_id,
            fallback_model,
            result_val,
        );
        self.append_entries(&entries).await
    }

    pub async fn record_codex_cumulative(
        &self,
        project_path: &str,
        thread_id: &str,
        provider_thread_id: Option<&str>,
        model: Option<&str>,
        token_usage: &Value,
    ) -> Result<(), String> {
        self.ensure_loaded().await?;
        let watermark_key = provider_thread_id.unwrap_or(thread_id);
        let prev = {
            let guard = self.codex_totals.lock().await;
            guard.get(watermark_key).cloned()
        };
        let (entry_opt, next_state) = normalize_codex_delta_entry(
            now_millis(),
            project_path,
            thread_id,
            model,
            token_usage,
            prev.as_ref(),
        );

        if let Some(entry) = entry_opt {
            self.append_entries(&[entry]).await?;
        }
        if let Some(state) = next_state {
            {
                let mut guard = self.codex_totals.lock().await;
                guard.insert(watermark_key.to_string(), state);
            }
            self.persist_watermarks().await?;
        }
        Ok(())
    }

    pub async fn record_acp_update(
        &self,
        provider: AgentProviderId,
        project_path: &str,
        thread_id: &str,
        model: Option<&str>,
        update: &Value,
    ) -> Result<(), String> {
        let Some(entry) = normalize_acp_usage_entry(
            now_millis(),
            provider,
            project_path,
            thread_id,
            model,
            update,
        ) else {
            return Ok(());
        };
        let snap = AcpLastSnapshot {
            input_tokens: entry.input_tokens,
            output_tokens: entry.output_tokens,
            cache_read_tokens: entry.cache_read_tokens,
            cache_write_tokens: entry.cache_write_tokens,
            reasoning_tokens: entry.reasoning_tokens,
            cost_usd: entry.cost_usd,
        };
        {
            let mut guard = self.acp_last.lock().await;
            if guard.get(thread_id) == Some(&snap) {
                return Ok(());
            }
            guard.insert(thread_id.to_string(), snap);
        }
        self.append_entries(&[entry]).await
    }

    pub async fn query(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        project_path: Option<&str>,
    ) -> Result<UsageLogQueryResult, String> {
        let content = {
            let _guard = self.io_lock.lock().await;
            match fs::read_to_string(&self.path).await {
                Ok(c) => c,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(e) => return Err(format!("Failed to read usage log: {e}")),
            }
        };

        let mut entries = Vec::new();
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<UsageLogEntry>(trimmed) else {
                continue;
            };
            if let Some(s) = start_ms {
                if entry.timestamp_ms < s {
                    continue;
                }
            }
            if let Some(e) = end_ms {
                if entry.timestamp_ms > e {
                    continue;
                }
            }
            if let Some(proj) = project_path {
                if entry.project_path != proj {
                    continue;
                }
            }
            entries.push(entry);
        }

        Ok(aggregate_entries(&entries))
    }
}

fn normalize_claude_total_input(
    uncached_input: Option<u64>,
    cache_read: Option<u64>,
    cache_write: Option<u64>,
) -> Option<u64> {
    if uncached_input.is_none() && cache_read.is_none() && cache_write.is_none() {
        return None;
    }
    Some(
        uncached_input
            .unwrap_or(0)
            .saturating_add(cache_read.unwrap_or(0))
            .saturating_add(cache_write.unwrap_or(0)),
    )
}

pub fn normalize_claude_result_entries(
    timestamp_ms: i64,
    project_path: &str,
    thread_id: &str,
    fallback_model: Option<&str>,
    result_val: &Value,
) -> Vec<UsageLogEntry> {
    let result_uuid = result_val
        .get("uuid")
        .or_else(|| result_val.get("session_id"))
        .and_then(|v| v.as_str());

    if let Some(mu_obj) = result_val.get("modelUsage").and_then(|v| v.as_object()) {
        if !mu_obj.is_empty() {
            let mut entries = Vec::with_capacity(mu_obj.len());
            for (model_name, data) in mu_obj {
                let uncached_input = data.get("inputTokens").and_then(|v| v.as_u64());
                let output_tokens = data.get("outputTokens").and_then(|v| v.as_u64());
                let cache_read_tokens = data.get("cacheReadInputTokens").and_then(|v| v.as_u64());
                let cache_write_tokens = data
                    .get("cacheCreationInputTokens")
                    .and_then(|v| v.as_u64());
                let input_tokens = normalize_claude_total_input(
                    uncached_input,
                    cache_read_tokens,
                    cache_write_tokens,
                );
                let cost_usd = data.get("costUSD").and_then(|v| v.as_f64());

                if input_tokens.is_none()
                    && output_tokens.is_none()
                    && cache_read_tokens.is_none()
                    && cache_write_tokens.is_none()
                    && cost_usd.is_none()
                {
                    continue;
                }

                let dedup_key = result_uuid.map(|u| format!("claude:{thread_id}:{u}:{model_name}"));
                entries.push(UsageLogEntry {
                    timestamp_ms,
                    project_path: project_path.to_string(),
                    thread_id: thread_id.to_string(),
                    provider: AgentProviderId::Claude,
                    model: Some(model_name.clone()),
                    input_tokens,
                    output_tokens,
                    cache_read_tokens,
                    cache_write_tokens,
                    reasoning_tokens: None,
                    cost_usd,
                    dedup_key,
                });
            }
            if !entries.is_empty() {
                return entries;
            }
        }
    }

    let u = result_val.get("usage");
    let uncached_input = u
        .and_then(|v| v.get("input_tokens"))
        .and_then(|v| v.as_u64());
    let output_tokens = u
        .and_then(|v| v.get("output_tokens"))
        .and_then(|v| v.as_u64());
    let cache_read_tokens = u
        .and_then(|v| v.get("cache_read_input_tokens"))
        .and_then(|v| v.as_u64());
    let cache_write_tokens = u
        .and_then(|v| v.get("cache_creation_input_tokens"))
        .and_then(|v| v.as_u64());
    let input_tokens =
        normalize_claude_total_input(uncached_input, cache_read_tokens, cache_write_tokens);
    let cost_usd = result_val.get("total_cost_usd").and_then(|v| v.as_f64());

    if input_tokens.is_none()
        && output_tokens.is_none()
        && cache_read_tokens.is_none()
        && cache_write_tokens.is_none()
        && cost_usd.is_none()
    {
        return Vec::new();
    }

    let dedup_key = result_uuid.map(|u| format!("claude:{thread_id}:{u}:summary"));
    vec![UsageLogEntry {
        timestamp_ms,
        project_path: project_path.to_string(),
        thread_id: thread_id.to_string(),
        provider: AgentProviderId::Claude,
        model: fallback_model.map(|s| s.to_string()),
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        reasoning_tokens: None,
        cost_usd,
        dedup_key,
    }]
}

fn delta_opt(cur: Option<u64>, prev: Option<u64>, reset: bool) -> Option<u64> {
    let c = cur?;
    if reset {
        return Some(c);
    }
    match prev {
        Some(p) => Some(c.saturating_sub(p)),
        None => Some(c),
    }
}

pub fn normalize_codex_delta_entry(
    timestamp_ms: i64,
    project_path: &str,
    thread_id: &str,
    model: Option<&str>,
    token_usage: &Value,
    prev: Option<&CodexCumulativeState>,
) -> (Option<UsageLogEntry>, Option<CodexCumulativeState>) {
    let Some(total) = token_usage.get("total") else {
        return (None, None);
    };

    let cur = CodexCumulativeState {
        input_tokens: total.get("inputTokens").and_then(|v| v.as_u64()),
        output_tokens: total.get("outputTokens").and_then(|v| v.as_u64()),
        cache_read_tokens: total.get("cachedInputTokens").and_then(|v| v.as_u64()),
        cache_write_tokens: total.get("cacheWriteInputTokens").and_then(|v| v.as_u64()),
        reasoning_tokens: total.get("reasoningOutputTokens").and_then(|v| v.as_u64()),
    };

    if cur.input_tokens.is_none()
        && cur.output_tokens.is_none()
        && cur.cache_read_tokens.is_none()
        && cur.cache_write_tokens.is_none()
        && cur.reasoning_tokens.is_none()
    {
        return (None, None);
    }

    if prev == Some(&cur) {
        return (None, Some(cur));
    }

    let reset = match prev {
        Some(p) => {
            matches!((cur.input_tokens, p.input_tokens), (Some(c), Some(pr)) if c < pr)
                || matches!((cur.output_tokens, p.output_tokens), (Some(c), Some(pr)) if c < pr)
                || matches!((cur.cache_read_tokens, p.cache_read_tokens), (Some(c), Some(pr)) if c < pr)
                || matches!((cur.cache_write_tokens, p.cache_write_tokens), (Some(c), Some(pr)) if c < pr)
                || matches!((cur.reasoning_tokens, p.reasoning_tokens), (Some(c), Some(pr)) if c < pr)
        }
        None => false,
    };

    let d_in = delta_opt(cur.input_tokens, prev.and_then(|p| p.input_tokens), reset);
    let d_out = delta_opt(cur.output_tokens, prev.and_then(|p| p.output_tokens), reset);
    let d_cr = delta_opt(
        cur.cache_read_tokens,
        prev.and_then(|p| p.cache_read_tokens),
        reset,
    );
    let d_cw = delta_opt(
        cur.cache_write_tokens,
        prev.and_then(|p| p.cache_write_tokens),
        reset,
    );
    let d_reas = delta_opt(
        cur.reasoning_tokens,
        prev.and_then(|p| p.reasoning_tokens),
        reset,
    );

    let any_nonzero = [d_in, d_out, d_cr, d_cw, d_reas]
        .into_iter()
        .flatten()
        .any(|v| v > 0);
    if !any_nonzero && prev.is_some() {
        return (None, Some(cur));
    }

    let entry = UsageLogEntry {
        timestamp_ms,
        project_path: project_path.to_string(),
        thread_id: thread_id.to_string(),
        provider: AgentProviderId::Codex,
        model: model.map(|s| s.to_string()),
        input_tokens: d_in,
        output_tokens: d_out,
        cache_read_tokens: d_cr,
        cache_write_tokens: d_cw,
        reasoning_tokens: d_reas,
        cost_usd: None,
        dedup_key: None,
    };

    (Some(entry), Some(cur))
}

pub fn normalize_acp_usage_entry(
    timestamp_ms: i64,
    provider: AgentProviderId,
    project_path: &str,
    thread_id: &str,
    model: Option<&str>,
    update: &Value,
) -> Option<UsageLogEntry> {
    // ACP `used` is context window occupancy, NEVER a token usage counter.
    let input_tokens = update.get("inputTokens").and_then(|v| v.as_u64());
    let output_tokens = update.get("outputTokens").and_then(|v| v.as_u64());
    let cache_read_tokens = update.get("cacheReadTokens").and_then(|v| v.as_u64());
    let cache_write_tokens = update.get("cacheWriteTokens").and_then(|v| v.as_u64());
    let reasoning_tokens = update.get("reasoningTokens").and_then(|v| v.as_u64());
    let cost_usd = update.get("cost").and_then(|c| {
        c.as_f64()
            .or_else(|| c.get("amount").and_then(|a| a.as_f64()))
    });

    if input_tokens.is_none()
        && output_tokens.is_none()
        && cache_read_tokens.is_none()
        && cache_write_tokens.is_none()
        && reasoning_tokens.is_none()
        && cost_usd.is_none()
    {
        return None;
    }

    Some(UsageLogEntry {
        timestamp_ms,
        project_path: project_path.to_string(),
        thread_id: thread_id.to_string(),
        provider,
        model: model.map(|s| s.to_string()),
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        reasoning_tokens,
        cost_usd,
        dedup_key: None,
    })
}

fn sum_opt_u64(acc: Option<u64>, val: Option<u64>) -> Option<u64> {
    match (acc, val) {
        (Some(a), Some(v)) => Some(a.saturating_add(v)),
        (Some(a), None) => Some(a),
        (None, Some(v)) => Some(v),
        (None, None) => None,
    }
}

fn sum_opt_f64(acc: Option<f64>, val: Option<f64>) -> Option<f64> {
    match (acc, val) {
        (Some(a), Some(v)) => Some(a + v),
        (Some(a), None) => Some(a),
        (None, Some(v)) => Some(v),
        (None, None) => None,
    }
}

fn summarize_slice(entries: &[&UsageLogEntry]) -> UsageSummary {
    let mut input_tokens = None;
    let mut output_tokens = None;
    let mut cache_read_tokens = None;
    let mut cache_write_tokens = None;
    let mut reasoning_tokens = None;
    let mut cost_usd = None;
    let mut threads = HashSet::new();

    let mut cache_share_read: u64 = 0;
    let mut cache_share_input: u64 = 0;
    let mut has_cache_share = false;

    for e in entries {
        input_tokens = sum_opt_u64(input_tokens, e.input_tokens);
        output_tokens = sum_opt_u64(output_tokens, e.output_tokens);
        cache_read_tokens = sum_opt_u64(cache_read_tokens, e.cache_read_tokens);
        cache_write_tokens = sum_opt_u64(cache_write_tokens, e.cache_write_tokens);
        reasoning_tokens = sum_opt_u64(reasoning_tokens, e.reasoning_tokens);
        cost_usd = sum_opt_f64(cost_usd, e.cost_usd);
        threads.insert(e.thread_id.as_str());

        if let (Some(cr), Some(inp)) = (e.cache_read_tokens, e.input_tokens) {
            if inp > 0 && cr <= inp {
                has_cache_share = true;
                cache_share_read = cache_share_read.saturating_add(cr);
                cache_share_input = cache_share_input.saturating_add(inp);
            }
        }
    }

    let cache_share =
        if has_cache_share && cache_share_input > 0 && cache_share_read <= cache_share_input {
            Some((cache_share_read as f64 / cache_share_input as f64).min(1.0))
        } else {
            None
        };

    UsageSummary {
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        reasoning_tokens,
        cost_usd,
        cache_share,
        hit_rate: None,
        threads_count: threads.len(),
    }
}

fn format_utc_date(timestamp_ms: i64) -> String {
    let secs = timestamp_ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm)
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn aggregate_entries(entries: &[UsageLogEntry]) -> UsageLogQueryResult {
    let refs: Vec<&UsageLogEntry> = entries.iter().collect();
    let total = summarize_slice(&refs);

    let mut by_provider_map: BTreeMap<String, (AgentProviderId, Vec<&UsageLogEntry>)> =
        BTreeMap::new();
    let mut by_pm: BTreeMap<(String, Option<String>), (AgentProviderId, Vec<&UsageLogEntry>)> =
        BTreeMap::new();
    let mut by_day_map: BTreeMap<(String, String), (AgentProviderId, Vec<&UsageLogEntry>)> =
        BTreeMap::new();
    let mut by_thread_map: BTreeMap<
        (String, String, String),
        (AgentProviderId, Vec<&UsageLogEntry>),
    > = BTreeMap::new();

    for e in entries {
        let p_key = serde_json::to_string(&e.provider).unwrap_or_default();
        by_provider_map
            .entry(p_key.clone())
            .or_insert_with(|| (e.provider, Vec::new()))
            .1
            .push(e);

        by_pm
            .entry((p_key.clone(), e.model.clone()))
            .or_insert_with(|| (e.provider, Vec::new()))
            .1
            .push(e);

        let date = format_utc_date(e.timestamp_ms);
        by_day_map
            .entry((date, p_key.clone()))
            .or_insert_with(|| (e.provider, Vec::new()))
            .1
            .push(e);

        by_thread_map
            .entry((e.thread_id.clone(), e.project_path.clone(), p_key))
            .or_insert_with(|| (e.provider, Vec::new()))
            .1
            .push(e);
    }

    let by_provider = by_provider_map
        .into_values()
        .map(|(provider, group)| UsageProviderRow {
            provider,
            summary: summarize_slice(&group),
        })
        .collect();

    let by_provider_model = by_pm
        .into_iter()
        .map(|((_, model), (provider, group))| UsageBreakdownRow {
            provider,
            model,
            summary: summarize_slice(&group),
        })
        .collect();

    let by_day = by_day_map
        .into_iter()
        .map(|((date, _), (provider, group))| {
            let s = summarize_slice(&group);
            UsageDailyRow {
                date,
                provider,
                input_tokens: s.input_tokens,
                output_tokens: s.output_tokens,
                cache_read_tokens: s.cache_read_tokens,
                cache_write_tokens: s.cache_write_tokens,
            }
        })
        .collect();

    let mut top_threads: Vec<UsageThreadRow> = by_thread_map
        .into_iter()
        .map(
            |((thread_id, project_path, _), (provider, group))| UsageThreadRow {
                thread_id,
                project_path,
                provider,
                summary: summarize_slice(&group),
            },
        )
        .collect();
    top_threads.sort_by(|a, b| {
        let a_tok = a
            .summary
            .input_tokens
            .unwrap_or(0)
            .saturating_add(a.summary.output_tokens.unwrap_or(0));
        let b_tok = b
            .summary
            .input_tokens
            .unwrap_or(0)
            .saturating_add(b.summary.output_tokens.unwrap_or(0));
        b_tok
            .cmp(&a_tok)
            .then_with(|| a.thread_id.cmp(&b.thread_id))
    });
    top_threads.truncate(10);

    UsageLogQueryResult {
        total,
        by_provider,
        by_provider_model,
        by_day,
        top_threads,
        entry_count: entries.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_result_normalization_preserves_explicit_zero_vs_absent() {
        let val = json!({
            "uuid": "res-1",
            "modelUsage": {
                "claude-sonnet-4-5": {
                    "inputTokens": 1200,
                    "outputTokens": 0,
                    "cacheReadInputTokens": 800,
                    "costUSD": 0.012
                }
            }
        });
        let entries =
            normalize_claude_result_entries(1_700_000_000_000, "/tmp/proj", "t1", None, &val);
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        // Normalized input includes uncached (1200) + cache_read (800) + cache_write (0)
        assert_eq!(e.input_tokens, Some(2000));
        assert_eq!(e.output_tokens, Some(0));
        assert_eq!(e.cache_read_tokens, Some(800));
        assert_eq!(e.cache_write_tokens, None);
        assert_eq!(e.reasoning_tokens, None);
        assert_eq!(e.cost_usd, Some(0.012));
    }

    #[test]
    fn codex_cumulative_delta_dedup_and_reset() {
        let tu1 = json!({
            "total": {
                "inputTokens": 500,
                "outputTokens": 100,
                "cachedInputTokens": 200
            }
        });
        let (e1, s1) = normalize_codex_delta_entry(1000, "/p", "t1", Some("o3"), &tu1, None);
        let e1 = e1.unwrap();
        assert_eq!(e1.input_tokens, Some(500));
        assert_eq!(e1.output_tokens, Some(100));
        assert_eq!(e1.cache_read_tokens, Some(200));
        assert_eq!(e1.cache_write_tokens, None);

        // Identical snapshot -> deduplicated
        let (e_dup, _) =
            normalize_codex_delta_entry(2000, "/p", "t1", Some("o3"), &tu1, s1.as_ref());
        assert!(e_dup.is_none());

        // Cumulative increase -> delta
        let tu2 = json!({
            "total": {
                "inputTokens": 850,
                "outputTokens": 150,
                "cachedInputTokens": 200
            }
        });
        let (e2, s2) = normalize_codex_delta_entry(3000, "/p", "t1", Some("o3"), &tu2, s1.as_ref());
        let e2 = e2.unwrap();
        assert_eq!(e2.input_tokens, Some(350));
        assert_eq!(e2.output_tokens, Some(50));
        assert_eq!(e2.cache_read_tokens, Some(0));

        // Reset/reconnect (counter drops) -> new value is delta
        let tu3 = json!({
            "total": {
                "inputTokens": 120,
                "outputTokens": 20,
                "cachedInputTokens": 0
            }
        });
        let (e3, _) = normalize_codex_delta_entry(4000, "/p", "t1", Some("o3"), &tu3, s2.as_ref());
        let e3 = e3.unwrap();
        assert_eq!(e3.input_tokens, Some(120));
        assert_eq!(e3.output_tokens, Some(20));
        assert_eq!(e3.cache_read_tokens, Some(0));
    }

    #[test]
    fn acp_never_uses_context_used_as_usage_count() {
        let only_ctx = json!({
            "sessionUpdate": "usage_update",
            "used": 14500,
            "size": 200000
        });
        assert!(normalize_acp_usage_entry(
            1000,
            AgentProviderId::Antigravity,
            "/p",
            "t1",
            None,
            &only_ctx
        )
        .is_none());

        let explicit = json!({
            "sessionUpdate": "usage_update",
            "used": 14500,
            "size": 200000,
            "inputTokens": 0,
            "outputTokens": 42
        });
        let e = normalize_acp_usage_entry(
            1000,
            AgentProviderId::Antigravity,
            "/p",
            "t1",
            None,
            &explicit,
        )
        .unwrap();
        assert_eq!(e.input_tokens, Some(0));
        assert_eq!(e.output_tokens, Some(42));
        assert_eq!(e.cache_read_tokens, None);
    }

    #[tokio::test]
    async fn persistence_query_scoping_and_cache_share() {
        let dir = std::env::temp_dir().join(format!("ox_usage_test_{}", now_millis()));
        let log_path = dir.join("usage_log.jsonl");
        let store = UsageLogStore::new(log_path);

        let claude_res = json!({
            "uuid": "u1",
            "modelUsage": {
                "claude-sonnet-4-5": {
                    "inputTokens": 1000,
                    "outputTokens": 200,
                    "cacheReadInputTokens": 500
                }
            }
        });
        store
            .record_claude_result("/proj/a", "t1", None, &claude_res)
            .await
            .unwrap();
        // Duplicate uuid should be deduplicated
        store
            .record_claude_result("/proj/a", "t1", None, &claude_res)
            .await
            .unwrap();

        let acp_res = json!({
            "inputTokens": 500,
            "outputTokens": 100
        });
        store
            .record_acp_update(
                AgentProviderId::Antigravity,
                "/proj/b",
                "t2",
                None,
                &acp_res,
            )
            .await
            .unwrap();

        let all = store.query(None, None, None).await.unwrap();
        assert_eq!(all.entry_count, 2);
        // Claude normalized input = 1000 + 500 = 1500; ACP = 500; total = 2000
        assert_eq!(all.total.input_tokens, Some(2000));
        assert_eq!(all.total.output_tokens, Some(300));
        assert_eq!(all.total.cache_read_tokens, Some(500));
        assert_eq!(all.total.hit_rate, None);
        // Cache share is 500 / 1500 = 1/3 (only Claude reported cache_read_tokens)
        assert!((all.total.cache_share.unwrap() - (500.0 / 1500.0)).abs() < 1e-6);
        assert_eq!(all.by_provider.len(), 2);
        assert_eq!(all.top_threads.len(), 2);
        assert_eq!(all.top_threads[0].thread_id, "t1");

        let proj_a = store.query(None, None, Some("/proj/a")).await.unwrap();
        assert_eq!(proj_a.entry_count, 1);
        assert_eq!(proj_a.total.threads_count, 1);

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[test]
    fn cache_share_never_exceeds_100_percent_and_omits_insufficient() {
        let inconsistent = UsageLogEntry {
            timestamp_ms: 1000,
            project_path: "/p".to_string(),
            thread_id: "t1".to_string(),
            provider: AgentProviderId::Antigravity,
            model: None,
            input_tokens: Some(100),
            output_tokens: Some(10),
            cache_read_tokens: Some(500),
            cache_write_tokens: None,
            reasoning_tokens: None,
            cost_usd: None,
            dedup_key: None,
        };
        let res = aggregate_entries(&[inconsistent]);
        assert_eq!(res.total.cache_share, None);

        let zero_input = UsageLogEntry {
            timestamp_ms: 1000,
            project_path: "/p".to_string(),
            thread_id: "t2".to_string(),
            provider: AgentProviderId::Claude,
            model: None,
            input_tokens: Some(0),
            output_tokens: Some(0),
            cache_read_tokens: Some(0),
            cache_write_tokens: None,
            reasoning_tokens: None,
            cost_usd: None,
            dedup_key: None,
        };
        let res_zero = aggregate_entries(&[zero_input]);
        assert_eq!(res_zero.total.input_tokens, Some(0));
        assert_eq!(res_zero.total.cache_share, None);

        let zero_cache = UsageLogEntry {
            timestamp_ms: 1000,
            project_path: "/p".to_string(),
            thread_id: "t3".to_string(),
            provider: AgentProviderId::Claude,
            model: None,
            input_tokens: Some(1000),
            output_tokens: Some(50),
            cache_read_tokens: Some(0),
            cache_write_tokens: None,
            reasoning_tokens: None,
            cost_usd: None,
            dedup_key: None,
        };
        let res_zc = aggregate_entries(&[zero_cache]);
        assert_eq!(res_zc.total.cache_share, Some(0.0));
    }

    #[tokio::test]
    async fn claude_dedup_persists_across_restart_and_write_failure_does_not_mark_seen() {
        let dir = std::env::temp_dir().join(format!("ox_usage_dedup_{}", now_millis()));
        let log_path = dir.join("usage_log.jsonl");

        let claude_res = json!({
            "uuid": "u-persist",
            "modelUsage": {
                "claude-sonnet-4-5": {
                    "inputTokens": 400,
                    "outputTokens": 100,
                    "cacheReadInputTokens": 600
                }
            }
        });

        {
            let store = UsageLogStore::new(log_path.clone());
            store
                .record_claude_result("/proj/a", "t1", None, &claude_res)
                .await
                .unwrap();
        }

        // Simulate app restart with a fresh UsageLogStore instance
        {
            let store2 = UsageLogStore::new(log_path.clone());
            store2
                .record_claude_result("/proj/a", "t1", None, &claude_res)
                .await
                .unwrap();
            let res = store2.query(None, None, None).await.unwrap();
            assert_eq!(res.entry_count, 1);
            assert_eq!(res.total.input_tokens, Some(1000));
        }

        // Write failure (path is a directory) must not mark dedup_key as seen
        tokio::fs::create_dir_all(dir.join("bad_dir"))
            .await
            .unwrap();
        let bad_store = UsageLogStore::new(dir.join("bad_dir"));
        let err = bad_store
            .record_claude_result("/proj/a", "t1", None, &claude_res)
            .await;
        assert!(err.is_err());
        assert!(bad_store.seen_dedup_keys.lock().await.is_empty());

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn codex_watermarks_persist_across_restart_by_provider_thread() {
        let dir = std::env::temp_dir().join(format!("ox_usage_codex_{}", now_millis()));
        let log_path = dir.join("usage_log.jsonl");

        let tu1 = json!({
            "total": {
                "inputTokens": 500,
                "outputTokens": 100,
                "cachedInputTokens": 200
            }
        });
        {
            let store = UsageLogStore::new(log_path.clone());
            store
                .record_codex_cumulative(
                    "/proj/a",
                    "local-1",
                    Some("codex-prov-1"),
                    Some("o3"),
                    &tu1,
                )
                .await
                .unwrap();
        }

        // Restart: replaying same cumulative snapshot for codex-prov-1 must not charge again
        {
            let store2 = UsageLogStore::new(log_path.clone());
            store2
                .record_codex_cumulative(
                    "/proj/a",
                    "local-1",
                    Some("codex-prov-1"),
                    Some("o3"),
                    &tu1,
                )
                .await
                .unwrap();

            let tu2 = json!({
                "total": {
                    "inputTokens": 650,
                    "outputTokens": 130,
                    "cachedInputTokens": 200
                }
            });
            store2
                .record_codex_cumulative(
                    "/proj/a",
                    "local-1",
                    Some("codex-prov-1"),
                    Some("o3"),
                    &tu2,
                )
                .await
                .unwrap();

            let res = store2.query(None, None, None).await.unwrap();
            assert_eq!(res.entry_count, 2);
            assert_eq!(res.total.input_tokens, Some(650));
            assert_eq!(res.total.output_tokens, Some(130));
            assert_eq!(res.total.threads_count, 1);
        }

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
