import React, { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import AsyncBoundary from "../components/AsyncBoundary";
import { useSuggestionStore } from "../state/suggestionStore";
import { PolicyFinding, PolicyPayload, PolicyScope } from "../types";
import "./SuggestionsPage.css";

type ProcessingAction = "proceed" | "discard" | "replace" | null;

type CustomDraft = {
  scopeType: PolicyScope;
  scopeId: string;
  policyText: string;
};

type ReviewOrigin =
  | { kind: "custom"; draft: CustomDraft }
  | { kind: "suggestion"; suggestionId: string; customDraft: CustomDraft }
  | null;

export default function SuggestionsPage({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const {
    suggestions,
    selectedId,
    reviewResolution,
    status,
    error,
    notice,
    noticePolicy,
    load,
    accept,
    addCustom,
    discardReviewCandidate,
    replaceWithReviewCandidate,
    clearReview,
    clearNotice,
  } = useSuggestionStore();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [scopeType, setScopeType] = useState<PolicyScope>("global");
  const [scopeId, setScopeId] = useState("");
  const [policyText, setPolicyText] = useState("");
  const [reviewOrigin, setReviewOrigin] = useState<ReviewOrigin>(null);
  const [processingAction, setProcessingAction] =
    useState<ProcessingAction>(null);

  useEffect(() => {
    if (!disabled) load();
  }, [disabled, load]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => {
      clearNotice();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [clearNotice, notice]);

  const currentDraft = (): CustomDraft => ({
    scopeType,
    scopeId,
    policyText,
  });

  const restoreDraft = (draft: CustomDraft) => {
    setScopeType(draft.scopeType);
    setScopeId(draft.scopeId);
    setPolicyText(draft.policyText);
  };

  const resetCustomForm = () => {
    setPolicyText("");
    setScopeId("");
    setScopeType("global");
  };

  const handleProceed = async () => {
    if (processingAction) return;
    setProcessingAction("proceed");
    try {
      if (activeId) {
        setReviewOrigin({
          kind: "suggestion",
          suggestionId: activeId,
          customDraft: currentDraft(),
        });
        await accept(activeId);
        const state = useSuggestionStore.getState();
        if (!state.reviewResolution && !state.error) {
          setActiveId(null);
          setReviewOrigin(null);
        }
        return;
      }

      const trimmed = policyText.trim();
      if (!trimmed) return;
      if (scopeType !== "global" && !scopeId.trim()) return;

      const draft = currentDraft();
      setReviewOrigin({ kind: "custom", draft });
      await addCustom({
        policy: trimmed,
        scope_type: scopeType,
        scope_id: parseScopeIdInput(scopeId, scopeType),
      });
      const state = useSuggestionStore.getState();
      if (!state.reviewResolution && !state.error) {
        resetCustomForm();
        setReviewOrigin(null);
      }
    } finally {
      setProcessingAction(null);
    }
  };

  const handleKeepReviewing = () => {
    if (reviewOrigin?.kind === "custom") {
      restoreDraft(reviewOrigin.draft);
    } else if (reviewOrigin?.kind === "suggestion") {
      restoreDraft(reviewOrigin.customDraft);
      setActiveId(reviewOrigin.suggestionId);
    }
    clearReview();
  };

  const handleDiscardReview = async () => {
    setProcessingAction("discard");
    try {
      await discardReviewCandidate();
      if (reviewOrigin?.kind === "custom") {
        restoreDraft(reviewOrigin.draft);
      } else if (reviewOrigin?.kind === "suggestion") {
        restoreDraft(reviewOrigin.customDraft);
        setActiveId(reviewOrigin.suggestionId);
      }
      setReviewOrigin(null);
    } finally {
      setProcessingAction(null);
    }
  };

  const handleReplaceReview = async () => {
    setProcessingAction("replace");
    try {
      await replaceWithReviewCandidate();
      const state = useSuggestionStore.getState();
      if (!state.reviewResolution && !state.error) {
        setActiveId(null);
        resetCustomForm();
        setReviewOrigin(null);
      }
    } finally {
      setProcessingAction(null);
    }
  };

  const isProceedDisabled =
    Boolean(processingAction) ||
    (!activeId && !policyText.trim()) ||
    (!activeId && scopeType !== "global" && !scopeId.trim());

  const handleScopeTypeChange = (value: PolicyScope) => {
    setScopeType(value);
    if (value === "global") {
      setScopeId("");
    }
  };

  if (reviewResolution) {
    return (
      <IntegratorReportPage
        candidate={reviewResolution.candidate}
        findings={reviewResolution.review.findings}
        relatedPolicies={reviewResolution.conflictingPolicies}
        rationale={reviewResolution.review.rationale}
        recommendation={reviewResolution.review.recommendation}
        processingAction={processingAction}
        onDiscard={handleDiscardReview}
        onKeepReviewing={handleKeepReviewing}
        onReplace={handleReplaceReview}
      />
    );
  }

  return (
    <div className="suggestions-page">
      {notice && (
        <PolicyToast
          notice={notice}
          policy={noticePolicy}
          onDismiss={clearNotice}
        />
      )}

      <section className="policy-section">
        <AsyncBoundary
          status={status}
          error={error}
          isEmpty={suggestions.length === 0}
          emptyMessage="No suggested policies."
          onRetry={load}
        >
          <div className="policy-list">
            {suggestions.map((suggestion) => (
              <PolicyCard
                key={suggestion.id}
                policy={suggestion}
                selected={
                  suggestion.id === activeId || suggestion.id === selectedId
                }
                onSelect={
                  disabled
                    ? undefined
                    : () => {
                        setActiveId(suggestion.id);
                      }
                }
              />
            ))}
          </div>
        </AsyncBoundary>
      </section>

      <section className="custom-policy-card">
        <h3 className="custom-policy-title">Custom Policy</h3>
        <div
          className={`custom-policy-header ${scopeType === "global" ? "global" : ""}`}
        >
          <select
            className="text-input scope-select"
            value={scopeType}
            disabled={disabled}
            onChange={(e) =>
              handleScopeTypeChange(e.target.value as PolicyScope)
            }
          >
            <option value="global">global</option>
            <option value="agent">agent</option>
            <option value="tool">tool</option>
            <option value="node">node</option>
          </select>
          {scopeType !== "global" && (
            <input
              type="text"
              className="text-input scope-id-input"
              placeholder={scopeIdPlaceholder(scopeType)}
              value={scopeId}
              disabled={disabled}
              onChange={(e) => setScopeId(e.target.value)}
            />
          )}
        </div>
        <textarea
          className="text-input custom-policy-input"
          rows={5}
          placeholder="Write a custom policy..."
          value={policyText}
          disabled={disabled}
          onChange={(e) => {
            setPolicyText(e.target.value);
            if (e.target.value.trim()) setActiveId(null);
          }}
          aria-label="Custom policy input"
        />
      </section>

      <button
        className="primary-btn proceed-btn"
        onClick={handleProceed}
        disabled={disabled || Boolean(isProceedDisabled)}
      >
        {processingAction === "proceed" && (
          <Loader2 className="button-spinner" size={16} />
        )}
        {activeId ? "Review Selected Policy" : "Review Custom Policy"}
      </button>
    </div>
  );
}

function IntegratorReportPage({
  candidate,
  findings,
  relatedPolicies,
  rationale,
  recommendation,
  processingAction,
  onDiscard,
  onKeepReviewing,
  onReplace,
}: {
  candidate: PolicyPayload;
  findings: PolicyFinding[];
  relatedPolicies: PolicyPayload[];
  rationale: string;
  recommendation: string;
  processingAction: ProcessingAction;
  onDiscard: () => void;
  onKeepReviewing: () => void;
  onReplace: () => void;
}) {
  const hasFindings = findings.length > 0;
  const resultClass = hasFindings ? "needs-work" : "clean";

  return (
    <div className="suggestions-page report-page">
      <section className={`integrator-report ${resultClass}`}>
        <div className="report-status-row">
          <span className="report-status">
            {hasFindings ? "Review needed" : "All good"}
          </span>
          <span className="report-recommendation">
            {formatRecommendation(recommendation)}
          </span>
        </div>
        <PolicyReferenceBanner
          policy={candidate}
          label="New policy"
          variant="candidate"
        />
        <p className="report-rationale">
          {rationale ||
            (hasFindings
              ? "The integrator found related active policies."
              : "No duplicate, overlap, or conflict was found.")}
        </p>
      </section>

      {hasFindings && (
        <section className="report-findings">
          {findings.map((finding) => {
            const related = relatedPolicies.find(
              (policy) => Number(policy.id) === finding.policy_id,
            );
            return (
              <ReviewFindingCard
                key={`${finding.policy_id}-${finding.relationship}`}
                finding={finding}
                relatedPolicy={related}
              />
            );
          })}
        </section>
      )}

      <div className="review-actions">
        <button
          className="policy-action-btn danger-btn"
          onClick={onDiscard}
          disabled={Boolean(processingAction)}
        >
          {processingAction === "discard" && (
            <Loader2 className="button-spinner" size={16} />
          )}
          Discard New Policy
        </button>
        <button
          className="policy-action-btn secondary-btn"
          onClick={onKeepReviewing}
          disabled={Boolean(processingAction)}
        >
          Keep Reviewing
        </button>
        <button
          className="policy-action-btn primary-btn"
          onClick={onReplace}
          disabled={Boolean(processingAction)}
        >
          {processingAction === "replace" && (
            <Loader2 className="button-spinner" size={16} />
          )}
          {hasFindings ? "Delete Old And Add New Policy" : "Add Policy"}
        </button>
      </div>
    </div>
  );
}

function PolicyToast({
  notice,
  policy,
  onDismiss,
}: {
  notice: string;
  policy: PolicyPayload | null;
  onDismiss: () => void;
}) {
  return (
    <div className="policy-toast" role="status" aria-live="polite">
      <div className="page-notice">
        <span>{notice}</span>
        <button
          className="notice-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss notification"
        >
          x
        </button>
        <span className="toast-timer" aria-hidden="true" />
      </div>
      {policy && <PolicyCard policy={policy} tone="clean" />}
    </div>
  );
}

function parseScopeIdInput(
  raw: string,
  scope: PolicyScope,
): string | string[] | undefined {
  if (scope === "global") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (scope === "tool" && trimmed.includes(",")) {
    const ids = trimmed
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return ids.length > 1 ? ids : ids[0];
  }
  return trimmed;
}

function scopeIdPlaceholder(scope: PolicyScope): string {
  if (scope === "global") return "";
  if (scope === "tool") return "tool id";
  if (scope === "node") return "node id";
  return "agent id";
}

interface CardProps {
  policy: PolicyPayload;
  selected?: boolean;
  tone?: "clean" | "needs-work";
  onSelect?: () => void;
}

function PolicyCard({ policy, selected, tone, onSelect }: CardProps) {
  const scopeIds = normalizeScopeIds(policy.scope_id);
  const hasScopeId = policy.scope_type !== "global" && scopeIds.length > 0;
  const className = [
    "policy-card",
    selected ? "selected" : "",
    tone ? `tone-${tone}` : "",
    onSelect ? "selectable" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article
      className={className}
      onClick={onSelect}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={(e) => e.key === "Enter" && onSelect?.()}
    >
      <div className="policy-card-header">
        <span className="policy-scope">{policy.scope_type}</span>
        {hasScopeId && (
          <span className="policy-scope-id" title={scopeIds.join(", ")}>
            {scopeIds.join(", ")}
          </span>
        )}
      </div>
      <div className="policy-text">{policy.policy}</div>
    </article>
  );
}

function ReviewFindingCard({
  finding,
  relatedPolicy,
}: {
  finding: PolicyFinding;
  relatedPolicy?: PolicyPayload;
}) {
  return (
    <article className="finding-card">
      <div className="finding-header">
        <span className="finding-relationship">
          {formatRecommendation(finding.relationship)}
        </span>
        <span className="finding-severity">{finding.severity}</span>
      </div>
      <PolicyReferenceBanner
        policy={relatedPolicy}
        text={finding.policy}
        label="Existing policy"
        variant="related"
      />
      <p className="conflict-reason">{finding.reason}</p>
    </article>
  );
}

function PolicyReferenceBanner({
  policy,
  text,
  label,
  variant,
}: {
  policy?: PolicyPayload;
  text?: string;
  label: string;
  variant: "candidate" | "related";
}) {
  const scopeIds = normalizeScopeIds(policy?.scope_id);
  const scopeLabel = policy ? formatScopeLabel(policy, scopeIds) : "";

  return (
    <div className={`policy-reference-banner ${variant}`}>
      <div className="policy-reference-meta">
        <span className="policy-reference-label">{label}</span>
        {scopeLabel && (
          <span className="policy-reference-scope" title={scopeLabel}>
            {scopeLabel}
          </span>
        )}
      </div>
      <div
        className={`policy-text ${
          variant === "related" ? "conflict-policy" : ""
        }`}
      >
        {policy?.policy ?? text}
      </div>
    </div>
  );
}

function normalizeScopeIds(scopeId: PolicyPayload["scope_id"]): string[] {
  if (!scopeId) return [];
  return Array.isArray(scopeId) ? scopeId : [scopeId];
}

function formatScopeLabel(policy: PolicyPayload, scopeIds: string[]): string {
  if (policy.scope_type === "global" || scopeIds.length === 0) {
    return policy.scope_type;
  }
  return `${policy.scope_type}: ${scopeIds.join(", ")}`;
}

function formatRecommendation(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
