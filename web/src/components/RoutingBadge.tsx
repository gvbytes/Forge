// Transparency requirement (SPEC §0.3): every assistant thought (llm.call
// trace / assistant message) shows which model@provider answered and WHY
// routing picked it. Data comes from the last wire `route` decision
// (payload.decision = RouteDecision), stored per task by the chat store.
export interface RouteBadgeData {
  modelKey: string;
  providerId: string;
  tier?: string;
  reasons: string[];
}

export function RoutingBadge({ route }: { route: RouteBadgeData }) {
  return (
    <span className="route-badge" tabIndex={0} aria-label={`routed to ${route.modelKey} via ${route.providerId}`}>
      <span className="route-dot" aria-hidden />
      <span className="route-label">
        {route.modelKey}<span className="dim">@</span>{route.providerId}
      </span>
      {route.tier && route.tier !== "?" && <span className="route-tier">{route.tier}</span>}
      <span className="route-tip" role="tooltip">
        <strong>why this route</strong>
        {route.reasons.length > 0 ? (
          <ul>
            {route.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : (
          <em className="dim">no reasons recorded</em>
        )}
      </span>
    </span>
  );
}
