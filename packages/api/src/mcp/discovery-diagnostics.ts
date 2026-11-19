/** Redacted runtime restriction: never includes hidden connector identities. */
export const CONNECTOR_SCOPE_RESTRICTION =
  'Connector discovery is limited by the current execution scope. Some connectors belong to a department or Project this turn cannot reach; searching again cannot bypass this restriction.'

export const CONNECTOR_SOURCE_RESTRICTION =
  'Protected source access is unavailable for this operation. Review its setup and current access before retrying.'

/** A web or public turn whose connector preparation failed outright (never an authority loss). */
export const CONNECTOR_PREPARATION_UNAVAILABLE =
  'Connected apps could not be prepared for this turn, so connector tools are unavailable right now. Retrying the request later may work.'
