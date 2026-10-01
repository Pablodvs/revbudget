import { createRouter, createWebHistory } from 'vue-router';
import { authClient } from '../lib/auth';

declare module 'vue-router' {
  interface RouteMeta {
    title?: string;
    public?: boolean;
    adminOnly?: boolean;
  }
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('../views/LoginView.vue'),
      meta: { public: true, title: 'Sign in' },
    },
    {
      path: '/',
      name: 'overview',
      component: () => import('../views/OverviewView.vue'),
      meta: { title: 'Overview' },
    },
    {
      path: '/wallets',
      name: 'wallets',
      component: () => import('../views/WalletsView.vue'),
      meta: { title: 'Wallets' },
    },
    {
      path: '/wallet/:id',
      name: 'wallet',
      component: () => import('../views/WalletDetailView.vue'),
      props: true,
      meta: { title: 'Wallet' },
    },
    {
      path: '/transactions',
      name: 'transactions',
      component: () => import('../views/TransactionsView.vue'),
      meta: { title: 'Transactions' },
    },
    {
      path: '/rules',
      name: 'rules',
      component: () => import('../views/RulesView.vue'),
      meta: { title: 'Rules' },
    },
    {
      path: '/stats',
      name: 'stats',
      component: () => import('../views/StatsView.vue'),
      meta: { title: 'Stats' },
    },
    {
      path: '/users',
      name: 'users',
      component: () => import('../views/UsersView.vue'),
      meta: { adminOnly: true, title: 'Users' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

// Subscribed once here: each useSession() call adds a subscription that is
// only released with a component scope, which the guard doesn't have.
const session = authClient.useSession();

router.beforeEach(async (to) => {
  const store = session.value;
  // Ordinary navigations trust the reactive session store (App.vue keeps it
  // subscribed) and cost no request. Ask the server instead when the store
  // has no signed-in user, since it is still pending on a fresh load and lags
  // right after sign-in, or when heading to /login: that is usually a 401 or a
  // sign-out, and the store may still hold the dead session, which would
  // bounce the user straight back to Overview.
  const cached = store.isPending ? null : store.data;
  // An unreachable API counts as signed out: a throwing guard aborts the
  // navigation and leaves a blank page instead of the sign-in form.
  const data =
    cached?.user && to.name !== 'login'
      ? cached
      : await authClient
          .getSession()
          .then((res) => res.data)
          .catch(() => null);
  const user = data?.user;

  if (!user) {
    if (to.meta.public) return true;
    return { name: 'login', query: { next: to.fullPath } };
  }

  if (to.name === 'login') return { name: 'overview' };

  if (to.meta.adminOnly && user.role !== 'admin') return { name: 'overview' };

  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · RevBudget` : 'RevBudget';
});
