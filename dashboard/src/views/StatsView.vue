<script setup lang="ts">
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { formatCents, formatMonth } from 'shared';
import { computed } from 'vue';
import VChart from 'vue-echarts';
import MonthNav from '../components/MonthNav.vue';
import QueryState from '../components/QueryState.vue';
import { useMonthlyStats, useTrends } from '../composables/useStats';
import { useFiltersStore } from '../stores/filters';
import { useThemeStore } from '../stores/theme';

use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const filters = useFiltersStore();
const month = computed({
  get: () => filters.activeMonth,
  set: (v) => filters.setMonth(v),
});

const stats = useMonthlyStats(month);
const trends = useTrends();
const theme = useThemeStore();

// Whole euros on the value axis ("€350", not "€350.00").
const axisEuro = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

// Axis, grid and tooltip styling shared by both charts, following the theme.
function baseOption(categories: string[]) {
  const c = theme.chartColors;
  return {
    textStyle: { fontFamily: 'DM Sans, ui-sans-serif, system-ui, sans-serif' },
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: number) => formatCents(v, 'EUR'),
      backgroundColor: c.tooltipBg,
      borderColor: c.axis,
      textStyle: { color: c.tooltipText },
    },
    xAxis: {
      type: 'category',
      data: categories,
      axisLabel: { color: c.text },
      axisLine: { lineStyle: { color: c.axis } },
      axisTick: { show: false },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: c.text, formatter: (v: number) => axisEuro.format(v / 100) },
      splitLine: { lineStyle: { color: c.grid } },
    },
  };
}

const barOption = computed(() => {
  const per = stats.data.value?.perWallet ?? [];
  const base = baseOption(per.map((w) => w.walletName));
  return {
    ...base,
    // One bar per wallet, so its tooltip can use that wallet's currency.
    tooltip: {
      ...base.tooltip,
      valueFormatter: (v: number, i: number) => formatCents(v, per[i]?.currency ?? 'EUR'),
    },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    series: [
      {
        type: 'bar',
        data: per.map((w) => ({ value: w.spent, itemStyle: { color: w.color } })),
        barMaxWidth: 40,
      },
    ],
  };
});

const lineOption = computed(() => {
  const t = trends.data.value;
  if (!t) return {};
  return {
    ...baseOption(t.months.map((m) => formatMonth(m, 'short'))),
    legend: {
      type: 'scroll',
      bottom: 0,
      textStyle: { color: theme.chartColors.text },
      pageTextStyle: { color: theme.chartColors.text },
      pageIconColor: theme.chartColors.text,
      pageIconInactiveColor: theme.chartColors.axis,
    },
    grid: { left: 8, right: 16, top: 16, bottom: 40, containLabel: true },
    series: t.series.map((s) => ({
      name: s.walletName,
      type: 'line',
      data: s.values,
      smooth: true,
      itemStyle: { color: s.color },
      lineStyle: { color: s.color },
    })),
  };
});

// Text alternatives for the canvas charts (screen readers get nothing from pixels).
const barSummary = computed(() => {
  const per = stats.data.value?.perWallet ?? [];
  const parts = per.map(
    (w) =>
      `${w.walletName} ${formatCents(w.spent, w.currency)} of ${formatCents(w.budget, w.currency)}`,
  );
  return `Spending per wallet in ${formatMonth(month.value)}: ${parts.join(', ') || 'no wallets'}.`;
});

const lineSummary = computed(() => {
  const t = trends.data.value;
  if (!t?.months.length) return 'Six-month spending trend: no data.';
  const first = t.months[0] ?? '';
  const last = t.months[t.months.length - 1] ?? '';
  const parts = t.series.map(
    (s) =>
      `${s.walletName} ${formatCents(s.values[0] ?? 0, 'EUR')} to ${formatCents(s.values[s.values.length - 1] ?? 0, 'EUR')}`,
  );
  return `Spending per wallet from ${formatMonth(first)} to ${formatMonth(last)}: ${parts.join(', ')}.`;
});
</script>

<template>
  <div class="space-y-8">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <h1 class="text-2xl font-semibold tracking-tight">Stats</h1>
      <MonthNav v-model="month" />
    </div>

    <section class="rounded-xl border border-zinc-800 bg-zinc-950 p-6">
      <h2 class="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wide">
        Spending per wallet · {{ formatMonth(month) }}
      </h2>
      <div v-if="stats.data.value?.perWallet.length" class="h-72" role="img" :aria-label="barSummary">
        <VChart :option="barOption" autoresize />
      </div>
      <p v-else class="h-72 grid place-items-center text-sm">
        <QueryState :query="stats" empty="No wallets yet" />
      </p>
    </section>

    <section class="rounded-xl border border-zinc-800 bg-zinc-950 p-6">
      <h2 class="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wide">
        6-month trend
      </h2>
      <div v-if="trends.data.value?.series.length" class="h-80" role="img" :aria-label="lineSummary">
        <VChart :option="lineOption" autoresize />
      </div>
      <p v-else class="h-80 grid place-items-center text-sm">
        <QueryState :query="trends" empty="No wallets yet" />
      </p>
    </section>

    <section class="rounded-xl border border-zinc-800 bg-zinc-950 p-6">
      <h2 class="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wide">
        Top 5 merchants · last 6 months
      </h2>
      <div class="divide-y divide-zinc-900">
        <div
          v-for="(m, i) in trends.data.value?.topMerchants ?? []"
          :key="m.merchantDisplay + i"
          class="py-3 flex items-center justify-between"
        >
          <div class="flex items-center gap-3">
            <span class="text-zinc-400 text-sm w-6 tabular-nums">#{{ i + 1 }}</span>
            <span class="font-medium">{{ m.merchantDisplay }}</span>
            <span class="text-xs text-zinc-400">{{ m.count }} tx</span>
          </div>
          <div class="tabular-nums font-semibold">{{ formatCents(m.total, 'EUR') }}</div>
        </div>
        <div v-if="!trends.data.value?.topMerchants.length" class="py-6 text-center text-sm">
          <QueryState :query="trends" empty="No spending yet" />
        </div>
      </div>
    </section>
  </div>
</template>
