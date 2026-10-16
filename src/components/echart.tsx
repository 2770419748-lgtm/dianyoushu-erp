"use client";

import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { DatasetComponent, GridComponent, LegendComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

// ECharts 的小封装：只按需引入折线图和柱状图，减小打包体积；容器变宽变窄时自动重绘（手机端也能看）。
// 容器还没宽度时（比如页面在后台标签页）先不画，等有宽度了再初始化，避免 ECharts 报"拿不到宽高"。
echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent, DatasetComponent, CanvasRenderer]);

export type EChartOption = echarts.EChartsCoreOption;

export function EChart({ option, height = 300 }: { option: EChartOption; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const optionRef = useRef(option);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ensure = () => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      if (!chartRef.current) {
        chartRef.current = echarts.init(el);
        chartRef.current.setOption(optionRef.current, true);
      } else {
        chartRef.current.resize();
      }
    };
    ensure();
    const observer = new ResizeObserver(ensure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    optionRef.current = option;
    chartRef.current?.setOption(option, true);
  }, [option]);

  return <div ref={ref} style={{ width: "100%", height }} />;
}
