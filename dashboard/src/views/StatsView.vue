<script setup lang="ts">
import { BarChart, LineChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { formatCents } from 'shared';
import { computed } from 'vue';
import VChart from 'vue-echarts';
import MonthNav from '../components/MonthNav.vue';
import { useMonthlyStats, useTrends } from '../composables/useStats';
import { useFiltersStore } from '../stores/filters';

use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  TitleComponent,
  LegendComponent,
  CanvasRenderer,
]);

const filters = useFiltersStore();
const month = computed({
  get: () => filters.activeMonth,
  set: (v) => filters.setMonth(v),
});

const stats = useMonthlyStats(month);
const trends = useTrends();

const barOption = computed(() => {
  const per = stats.data.value?.perWallet ?? [];
  return {
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatCents(v, 'EUR') },
    grid: { left: 60, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: 'category',
      data: per.map((w) => w.walletName),
      axisLabel: { color: '#a1a1aa' },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        color: '#71717a',
        formatter: (v: number) => formatCents(v, 'EUR'),
      },
    },
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
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatCents(v, 'EUR') },
    legend: { textStyle: { color: '#a1a1aa' }, bottom: 0 },
    grid: { left: 60, right: 20, top: 20, bottom: 60 },
    xAxis: { type: 'category', data: t.months, axisLabel: { color: '#a1a1aa' } },
    yAxis: {
      type: 'value',
      axisLabel: {
        color: '#71717a',
        formatter: (v: number) => formatCents(v, 'EUR'),
      },
    },
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
</script>

<template>
  <div class="space-y-8">
    <div class="flex items-center justify-between flex-wrap gap-4">
      <h1 class="text-2xl font-semibold tracking-tight">Stats</h1>
      <MonthNav v-model="month" />
    </div>

    <section class="rounded-xl border border-zinc-800 bg-zinc-950 p-6">
      <h2 class="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wide">
        Spending per wallet · {{ month }}
      </h2>
      <VChart class="w-full h-72" :option="barOption" autoresize />
    </section>

    <section class="rounded-xl border border-zinc-800 bg-zinc-950 p-6">
      <h2 class="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wide">
        6-month trend
      </h2>
      <VChart class="w-full h-80" :option="lineOption" autoresize />
    </section>

    <section class="rounded-xl border border-zinc-800 bg-zinc-950 p-6">
      <h2 class="text-sm font-medium text-zinc-400 mb-3 uppercase tracking-wide">
        Top 5 merchants
      </h2>
      <div class="divide-y divide-zinc-900">
        <div
          v-for="(m, i) in trends.data.value?.topMerchants ?? []"
          :key="m.merchantDisplay + i"
          class="py-3 flex items-center justify-between"
        >
          <div class="flex items-center gap-3">
            <span class="text-zinc-500 text-sm w-6 tabular-nums">#{{ i + 1 }}</span>
            <span class="font-medium">{{ m.merchantDisplay }}</span>
            <span class="text-xs text-zinc-500">{{ m.count }} tx</span>
          </div>
          <div class="tabular-nums font-semibold">{{ formatCents(m.total, 'EUR') }}</div>
        </div>
        <div v-if="!(trends.data.value?.topMerchants ?? []).length" class="py-6 text-center text-zinc-500 text-sm">
          No data
        </div>
      </div>
    </section>
  </div>
</template>
