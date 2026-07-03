"use client";

/**
 * Scorecard Upload — drag-and-drop .xlsm file upload.
 */

import { useState, useCallback } from "react";
import { Upload, FileSpreadsheet, AlertCircle } from "lucide-react";
import { uploadScorecard } from "@/lib/client/api";
import type { NormalizedScorecard } from "@/lib/types";

interface ScorecardUploadProps {
  onUploaded: (scorecard: NormalizedScorecard) => void;
}

export function ScorecardUpload({ onUploaded }: ScorecardUploadProps) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setUploading(true);

      try {
        const scorecard = await uploadScorecard(file);
        onUploaded(scorecard);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [onUploaded]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const onFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-all cursor-pointer
        ${dragging
          ? "border-accent-400 bg-accent-500/10"
          : "border-border hover:border-primary-500/50 hover:bg-surface-overlay/30"
        }
        ${uploading ? "opacity-50 pointer-events-none" : ""}
      `}
    >
      <input
        type="file"
        accept=".xlsm,.xlsx,.xls"
        onChange={onFileInput}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        id="scorecard-upload"
      />

      <div className="flex flex-col items-center gap-3">
        {uploading ? (
          <div className="animate-spin rounded-full h-10 w-10 border-2 border-accent-400 border-t-transparent" />
        ) : (
          <>
            <div className="p-3 rounded-xl bg-primary-800/30">
              {dragging ? (
                <FileSpreadsheet size={28} className="text-accent-400" />
              ) : (
                <Upload size={28} className="text-primary-300" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium text-text-primary">
                {dragging ? "Drop your scorecard here" : "Upload a completed scorecard"}
              </p>
              <p className="text-xs text-text-secondary mt-1">
                Drag & drop or click · .xlsm, .xlsx, or .xls
              </p>
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2 text-sm text-danger-400">
          <AlertCircle size={14} />
          {error}
        </div>
      )}
    </div>
  );
}