export async function post(path: string, body: unknown) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiError(typeof data.detail === 'string' ? data.detail : 'La requête a échoué. Vérifiez les informations et réessayez.', response.status);
    }
    return response;
  } finally { window.clearTimeout(timeout); }
}
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function requestError(error: unknown, action = false) {
  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) {
    return action
      ? 'La réponse de l’action n’a pas été reçue. Son résultat est incertain ; elle ne sera pas relancée automatiquement. Vérifiez la connexion avant de continuer.'
      : 'Le serveur est injoignable. Vérifiez que l’API est démarrée, puis réessayez votre demande.';
  }
  return error instanceof Error ? error.message : 'La demande a échoué. Réessayez.';
}
