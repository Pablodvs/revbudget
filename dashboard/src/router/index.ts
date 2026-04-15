import { createRouter, createWebHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
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
  ],
});
