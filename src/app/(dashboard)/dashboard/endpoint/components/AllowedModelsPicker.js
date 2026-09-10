"use client";

// Fork addition: searchable, selection-first model picker used by the
// allowed-models modals on the endpoint page. New file — not present upstream.
//
// UX contract:
//   - selected models are pinned at the top as removable chips (always visible)
//   - the scrollable list below shows only unselected models, filtered by the
//     search box (case-insensitive substring)
//   - onChange receives the full selected array (order: selection order)

import { useMemo, useState } from "react";

export default function AllowedModelsPicker({ models, selected, onChange }) {
  const [query, setQuery] = useState("");

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedModels = useMemo(
    () => models.filter((m) => selectedSet.has(m)),
    [models, selectedSet]
  );
  const unselected = useMemo(
    () => models.filter((m) => !selectedSet.has(m)),
    [models, selectedSet]
  );
  const q = query.trim().toLowerCase();
  const visible = q ? unselected.filter((m) => m.toLowerCase().includes(q)) : unselected;

  const toggle = (model, on) => {
    onChange(on ? [...selected, model] : selected.filter((m) => m !== model));
  };

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search model…"
        className="w-full mb-2 px-2 py-1.5 text-xs border border-black/10 dark:border-white/10 rounded-lg bg-transparent outline-none focus:border-primary/50"
      />

      {/* Allowed models — pinned at the top */}
      {selectedModels.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {selectedModels.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => toggle(m, false)}
              title="Click to remove"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-mono bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
            >
              {m}
              <span className="material-symbols-outlined text-[12px]">close</span>
            </button>
          ))}
        </div>
      )}

      <div className="max-h-44 overflow-y-auto border border-black/10 dark:border-white/10 rounded-lg p-2 flex flex-col gap-1">
        {visible.length === 0 && (
          <p className="text-xs text-text-muted px-1">
            {q ? `No models match "${query}".` : "All available models are selected."}
          </p>
        )}
        {visible.map((model) => (
          <label
            key={model}
            className="flex items-center gap-2 text-sm cursor-pointer hover:bg-black/5 dark:hover:bg-white/5 rounded px-1 py-0.5"
          >
            <input
              type="checkbox"
              checked={false}
              onChange={() => toggle(model, true)}
              className="accent-current"
            />
            <span className="font-mono text-xs">{model}</span>
          </label>
        ))}
      </div>

      <p className="text-xs mt-2">
        {selected.length} model{selected.length === 1 ? "" : "s"} allowed
      </p>
    </div>
  );
}
