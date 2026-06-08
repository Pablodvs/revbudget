import { createRouter, createWebHistory } from 'vue-router';
import { authClient } from '../lib/auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
      meta: { public: true },
    },
    { path: '/', name: 'overview', component: () => import('../views/OverviewView.vue') },
    { path: '/wallets', name: 'wallets', component: () => import('../views/WalletsView.vue') },
    {
      path: '/wallet/:id',
      name: 'wallet',
      component: () => import('../views/WalletDetailView.vue'),
      props: true,
    },
    {
      path: '/transactions',
      name: 'transactions',
      component: () => import('../views/TransactionsView.vue'),
    },
    { path: '/rules', name: 'rules', component: () => import('../views/RulesView.vue') },
    { path: '/stats', name: 'stats', component: () => import('../views/StatsView.vue') },
    {
      path: '/users',
      name: 'users',
      component: () => import('../views/UsersView.vue'),
      meta: { adminOnly: true },
    },
  ],
});

router.beforeEach(async (to) => {
  const store = authClient.useSession();
  // On a fresh load/refresh the reactive session store hasn't resolved yet, so a
  // synchronous read would bounce an authenticated user to /login. Fetch the
  // session directly the first time; once the store resolves (App.vue keeps it
  // subscribed) later navigations read it synchronously without another request.
  const data = store.value.isPending ? (await authClient.getSession()).data : store.value.data;
  const user = data?.user;

  if (!user) {
    if (to.meta.public) return true;
    return { name: 'login', query: { next: to.fullPath } };
  }

  if (to.name === 'login') return { name: 'overview' };

  if (to.meta.adminOnly && user.role !== 'admin') return { name: 'overview' };

  return true;
});
