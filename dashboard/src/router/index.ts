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

router.beforeEach((to) => {
  const session = authClient.useSession().value;
  const user = session.data?.user;

  if (!user) {
    if (to.meta.public) return true;
    return { name: 'login', query: { next: to.fullPath } };
  }

  if (to.name === 'login') return { name: 'overview' };

  if (to.meta.adminOnly && user.role !== 'admin') return { name: 'overview' };

  return true;
});
