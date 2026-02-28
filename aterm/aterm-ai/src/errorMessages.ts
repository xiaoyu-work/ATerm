/**
 * Format HTTP API errors into user-friendly messages.
 */
export function formatApiError (status: number, body: string): string {
    let msg = ''
    try {
        const json = JSON.parse(body)
        msg = json?.error?.message || json?.message || ''
    } catch {
        // not JSON
    }

    switch (status) {
        case 400:
            if (msg.toLowerCase().includes('api key')) {
                return 'Invalid API key. Check your key in Settings → AI.'
            }
            if (msg.toLowerCase().includes('header')) {
                return msg
            }
            return msg ? `Bad request: ${msg}` : 'Bad request. Check your AI settings.'
        case 401:
            if (msg.toLowerCase().includes('expired')) {
                return 'Token expired. Open a new terminal tab to refresh.'
            }
            return 'Authentication failed. Your API key or token may be invalid. Check Settings → AI.'
        case 403:
            return 'Access denied. Your API key may not have permission for this model.'
        case 404:
            return 'API endpoint not found. The provider URL or model may be incorrect. Check Settings → AI.'
        case 421:
            return 'Request sent to wrong server. Try opening a new terminal tab.'
        case 429:
            return 'Rate limited. Too many requests — please wait a moment and try again.'
        case 500:
        case 502:
        case 503:
            return 'The AI service is temporarily unavailable. Please try again later.'
        default:
            return msg || `Server error (${status}). Please try again.`
    }
}
