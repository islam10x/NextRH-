import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

const api = axios.create({
    baseURL: import.meta.env.VITE_API_URL || 'http://localhost:3000',
    headers: {
        'Content-Type': 'application/json',
    },
    // Required so the browser sends the HTTPOnly refresh_token cookie automatically
    withCredentials: true,
});

// Request Interceptor: Attach Token
api.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
        const token = sessionStorage.getItem('access_token');
        if (token) {
            config.headers.set('Authorization', `Bearer ${token}`);
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
                // Use a fresh axios instance to avoid interceptor loop.
                // The HTTPOnly cookie is sent automatically (withCredentials).
                const response = await axios.post(
                    `${api.defaults.baseURL}/auth/refresh`,
                    {},
                    { withCredentials: true },
                );

                const { access_token } = response.data;

                sessionStorage.setItem('access_token', access_token);

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
