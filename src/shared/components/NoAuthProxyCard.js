"use client";

import PropTypes from "prop-types";
import Card from "./Card";

export default function NoAuthProxyCard({ providerId }) {
  return (
    <Card>
      <div className="flex items-center gap-3">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">This provider is ready to use — no connection or API key needed.</p>
        </div>
      </div>
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
