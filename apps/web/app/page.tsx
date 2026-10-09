'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

export default function RootPage() {
  const { loading, session, profile } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace('/login');
    } else if (profile?.role === 'md' || profile?.role === 'admin' || profile?.role === 'planner') {
      router.replace('/dashboard');
    } else {
      router.replace('/work-orders');
    }
  }, [loading, session, profile, router]);

  return null;
}
