import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import api from '@/services/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { FileText, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';

const SetupPasswordPage: React.FC = () => {
    const [searchParams] = useSearchParams();
    const token = searchParams.get('token');
    const navigate = useNavigate();

    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [isValidating, setIsValidating] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isSuccess, setIsSuccess] = useState(false);
    const [countdown, setCountdown] = useState(5);
    const [isValid, setIsValid] = useState(false);
    const [email, setEmail] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (isSuccess && countdown > 0) {
            interval = setInterval(() => {
                setCountdown((prev) => prev - 1);
            }, 1000);
        } else if (isSuccess && countdown === 0) {
            navigate('/login');
        }
        return () => clearInterval(interval);
    }, [isSuccess, countdown, navigate]);

    useEffect(() => {
        const validateToken = async () => {
            if (!token) {
                setError('No invitation token provided.');
                setIsValidating(false);
                return;
            }

            try {
                const response = await api.get(`/auth/validate-token?token=${token}`);
                if (response.data.valid) {
                    setIsValid(true);
                    setEmail(response.data.email);
                } else {
                    setError('This invitation is invalid or has expired.');
                }
            } catch (err: any) {
                setError(err.response?.data?.message || 'Failed to validate invitation.');
            } finally {
                setIsValidating(false);
            }
        };

        validateToken();
    }, [token]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (password !== confirmPassword) {
            toast.error('Passwords do not match');
            return;
        }

        if (password.length < 8) {
            toast.error('Password must be at least 8 characters');
            return;
        }

        setIsSubmitting(true);
        try {
            await api.post('/auth/setup-password', {
                token,
                password,
            });

            setIsSuccess(true);
            toast.success('Account activated successfully!');
        } catch (err: any) {
            toast.error(err.response?.data?.message || 'Failed to set password');
        } finally {
            setIsSubmitting(false);
        }
    };

    if (isValidating) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-accent/5 p-4">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    <p className="text-muted-foreground">Validating your invitation...</p>
                </div>
            </div>
        );
    }

    if (isSuccess) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/10 via-background to-accent/10 p-4 relative overflow-hidden">
                {/* Visual decorations for a premium feel */}
                <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-3xl" />
                <div className="absolute bottom-[-10%] left-[-10%] w-[40%] h-[40%] bg-accent/5 rounded-full blur-3xl" />

                <Card className="w-full max-w-md shadow-[0_20px_50px_rgba(0,0,0,0.12)] border-0 overflow-hidden animate-in fade-in zoom-in duration-700 bg-white/90 backdrop-blur-md">
                    <div className="h-1.5 w-full bg-muted/30 overflow-hidden">
                        <div
                            className="h-full bg-primary transition-all duration-1000 ease-linear"
                            style={{ width: `${(countdown / 5) * 100}%` }}
                        />
                    </div>
                    <CardHeader className="text-center pt-12">
                        <div className="flex justify-center mb-8">
                            <div className="relative">
                                <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl animate-pulse" />
                                <div className="relative h-20 w-20 rounded-full bg-primary flex items-center justify-center shadow-lg shadow-primary/30">
                                    <CheckCircle2 className="h-10 w-10 text-white" />
                                </div>
                            </div>
                        </div>
                        <CardTitle className="text-3xl font-bold tracking-tight">Account Ready</CardTitle>
                        <CardDescription className="text-base mt-2">
                            Welcome to the <span className="text-primary font-semibold">NextRH</span> workspace.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="text-center pb-16 pt-4 flex flex-col items-center">
                        <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground/60 mb-8">
                            Redirecting to Portal
                        </p>

                        <div className="relative flex items-center justify-center h-40 w-40">
                            <svg className="h-full w-full transform -rotate-90">
                                <circle
                                    cx="80"
                                    cy="80"
                                    r="74"
                                    stroke="currentColor"
                                    strokeWidth="4"
                                    fill="transparent"
                                    className="text-muted/20"
                                />
                                <circle
                                    cx="80"
                                    cy="80"
                                    r="74"
                                    stroke="currentColor"
                                    strokeWidth="4"
                                    fill="transparent"
                                    strokeDasharray={464.9}
                                    strokeDashoffset={464.9 - (countdown / 5) * 464.9}
                                    className="text-primary transition-all duration-1000 ease-linear"
                                    strokeLinecap="round"
                                />
                            </svg>
                            <span className="absolute text-6xl font-black text-foreground tabular-nums">
                                {countdown}
                            </span>
                        </div>

                        <p className="mt-8 text-sm text-muted-foreground flex items-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin text-primary" />
                            Finalizing your workspace...
                        </p>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (!isValid) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-accent/5 p-4">
                <Card className="w-full max-w-md shadow-xl border-0">
                    <CardHeader className="text-center">
                        <div className="flex justify-center mb-4">
                            <XCircle className="h-12 w-12 text-destructive" />
                        </div>
                        <CardTitle className="text-xl">Invalid Request</CardTitle>
                        <CardDescription>{error}</CardDescription>
                    </CardHeader>
                    <CardFooter>
                        <Button className="w-full h-11" onClick={() => navigate('/login')}>
                            Back to Login
                        </Button>
                    </CardFooter>
                </Card>
            </div>
        );
    }

    return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 via-background to-accent/5 p-4">
            <div className="w-full max-w-md">
                <div className="flex items-center justify-center gap-3 mb-8">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg">
                        <FileText className="h-6 w-6" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">CV Manager</h1>
                        <p className="text-sm text-muted-foreground">Setup Your Account</p>
                    </div>
                </div>

                <Card className="shadow-xl border-0">
                    <CardHeader className="text-center pb-4">
                        <CardTitle className="text-xl">Complete Your Setup</CardTitle>
                        <CardDescription>
                            Welcome! Setting up account for <span className="font-medium text-foreground">{email}</span>
                        </CardDescription>
                    </CardHeader>

                    <form onSubmit={handleSubmit}>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label htmlFor="password">New Password</Label>
                                <Input
                                    id="password"
                                    type="password"
                                    placeholder="••••••••"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="h-11"
                                    required
                                />
                                <p className="text-[10px] text-muted-foreground">
                                    At least 8 characters, one uppercase, one number.
                                </p>
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="confirmPassword">Confirm Password</Label>
                                <Input
                                    id="confirmPassword"
                                    type="password"
                                    placeholder="••••••••"
                                    value={confirmPassword}
                                    onChange={(e) => setConfirmPassword(e.target.value)}
                                    className="h-11"
                                    required
                                />
                            </div>
                        </CardContent>

                        <CardFooter className="flex-col gap-4">
                            <Button type="submit" className="w-full h-11" disabled={isSubmitting}>
                                {isSubmitting ? (
                                    <>
                                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                        Processing...
                                    </>
                                ) : (
                                    'Set Password & Activate'
                                )}
                            </Button>
                        </CardFooter>
                    </form>
                </Card>
            </div>
        </div>
    );
};

export default SetupPasswordPage;
