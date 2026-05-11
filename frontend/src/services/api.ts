import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

const api = axios.create({
    baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3000',
    headers: {
        'Content-Type': 'application/json',
    },
    // Keep credentials disabled by default; refresh now uses per-tab session storage.
    withCredentials: false,
});

// Request Interceptor: Attach Token
api.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
        // Blast Shield: If we are in the middle of a logout/session-expiry transition,
        // block all new outgoing requests to prevent infinite 401 loops.
        if ((window as any)._isLoggingOut) {
            return Promise.reject(new Error('LOGGING_OUT'));
        }
        
        const token = sessionStorage.getItem('access_token');
        const sessionId = sessionStorage.getItem('session_id');
        if (token) {
            config.headers.set('Authorization', `Bearer ${token}`);
        }
        if (sessionId) {
            config.headers.set('x-session-id', sessionId);
        }
        return config;
    },
    (error) => Promise.reject(error)
);

// Response Interceptor: Handle 401 & Refresh
let isRefreshing = false;
let failedQueue: Array<{
    resolve: (value?: unknown) => void;
    reject: (reason?: any) => void;
}> = [];

const processQueue = (error: any, token: string | null = null) => {
    failedQueue.forEach((prom) => {
        if (error) {
            prom.reject(error);
        } else {
            prom.resolve(token);
        }
    });

    failedQueue = [];
};

api.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
        const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
        const url = String(originalRequest?.url || '');

        if (url.includes('/auth/logout') || url.includes('/auth/login')) {
            return Promise.reject(error);
        }

        // If it's a 401 error and not the retry request
        if (error.response?.status === 401 && !originalRequest._retry) {
            if (isRefreshing) {
                return new Promise(function (resolve, reject) {
                    failedQueue.push({ resolve, reject });
                })
                    .then((token) => {
                        // Safe header setting for older/newer Axios
                        if (originalRequest.headers.set) {
                            originalRequest.headers.set('Authorization', `Bearer ${token}`);
                        } else {
                            originalRequest.headers['Authorization'] = `Bearer ${token}`;
                        }
                        return api(originalRequest);
                    })
                    .catch((err) => Promise.reject(err));
            }

            originalRequest._retry = true;
            isRefreshing = true;

            try {
                const sessionId = sessionStorage.getItem('session_id');
                const refreshToken = sessionStorage.getItem('refresh_token');
                if (!sessionId || !refreshToken) {
                    processQueue(new Error('MISSING_SESSION'), null);
                    (window as any)._isLoggingOut = true;
                    window.dispatchEvent(new Event('auth:logout'));
                    return Promise.reject(error);
                }

                // Use a fresh axios instance to avoid interceptor loop.
                const response = await axios.post(
                    `${api.defaults.baseURL}/auth/refresh`,
                    { session_id: sessionId, refresh_token: refreshToken },
                );

                const { access_token, user, refresh_token, session_id } = response.data as {
                    access_token: string;
                    refresh_token?: string;
                    session_id?: string;
                    user?: any;
                };
                const storedUserRaw = sessionStorage.getItem('user');
                const storedUser = storedUserRaw ? (JSON.parse(storedUserRaw) as { id?: string; role?: string }) : null;
                const refreshedUserId = user?.id || user?.user_id;
                const refreshedUserRole = user?.role;

                if (storedUser?.id && refreshedUserId && storedUser.id !== refreshedUserId) {
                    // Prevent cross-tab session swap due to shared refresh cookie.
                    sessionStorage.removeItem('access_token');
                    sessionStorage.removeItem('user');
                    sessionStorage.removeItem('refresh_token');
                    sessionStorage.removeItem('session_id');
                    processQueue(new Error('SESSION_MISMATCH'), null);
                    (window as any)._isLoggingOut = true;
                    window.dispatchEvent(new Event('auth:logout'));
                    return Promise.reject(error);
                }

                if (storedUser?.role && refreshedUserRole && storedUser.role !== refreshedUserRole) {
                    sessionStorage.removeItem('access_token');
                    sessionStorage.removeItem('user');
                    sessionStorage.removeItem('refresh_token');
                    sessionStorage.removeItem('session_id');
                    processQueue(new Error('SESSION_ROLE_MISMATCH'), null);
                    window.dispatchEvent(new Event('auth:logout'));
                    return Promise.reject(error);
                }

                sessionStorage.setItem('access_token', access_token);
                if (refresh_token) {
                    sessionStorage.setItem('refresh_token', refresh_token);
                }
                if (session_id) {
                    sessionStorage.setItem('session_id', session_id);
                }

                // Update defaults for future requests
                api.defaults.headers.common['Authorization'] = `Bearer ${access_token}`;
                processQueue(null, access_token);

                // Update current request headers and retry
                if (originalRequest.headers.set) {
                    originalRequest.headers.set('Authorization', `Bearer ${access_token}`);
                } else {
                    originalRequest.headers['Authorization'] = `Bearer ${access_token}`;
                }

                return api(originalRequest);
            } catch (err) {
                processQueue(err, null);
                (window as any)._isLoggingOut = true;
                window.dispatchEvent(new Event('auth:logout'));
                return Promise.reject(err);
            } finally {
                isRefreshing = false;
            }
        }

        return Promise.reject(error);
    }
);

export default api;
