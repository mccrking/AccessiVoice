import { ApiError, post } from './api';

// Only a rejected command may be retried. An action whose response was lost
// must never be replayed: the server may already have executed it.
export function createSessionClient(onExpired: () => void) {
  let session: Promise<string> | null = null;

  function get() {
    if (!session) {
      session = post('sessions', {}).then(response => response.json()).then(data => {
        if (typeof data.session_id !== 'string' || !data.session_id) throw new Error('Session indisponible. Réessayez.');
        return data.session_id as string;
      }).catch(error => { session = null; throw error; });
    }
    return session;
  }

  async function send(path: string, body: Record<string, unknown>, retryCommand = false): Promise<Response> {
    const id = await get();
    try {
      return await post(path, { ...body, session_id: id });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      session = null;
      onExpired();
      if (retryCommand) return send(path, body, false);
      throw new ApiError('La session a expiré. Relancez votre demande ; aucune confirmation précédente ne sera réutilisée.', 401);
    }
  }

  return { send };
}
