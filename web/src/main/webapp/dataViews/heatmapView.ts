/*
 * Copyright (c) 2017 VMware Inc. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {mouse as d3mouse} from "d3-selection";
import {HeatmapSerialization, IViewSerialization} from "../datasetView";
import {
    Groups,
    IColumnDescription, kindIsNumeric,
    RecordOrder,
    RemoteObjectId,
} from "../javaBridge";
import {Receiver} from "../rpc";
import {DisplayName, SchemaClass} from "../schemaClass";
import {BaseReceiver, TableTargetAPI} from "../tableTarget";
import {IDataView} from "../ui/dataview";
import {DragEventKind, FullPage, PageTitle} from "../ui/fullPage";
import {HeatmapPlot} from "../ui/heatmapPlot";
import {HistogramPlot} from "../ui/histogramPlot";
import {SubMenu, TopMenu} from "../ui/menu";
import {HtmlPlottingSurface, PlottingSurface} from "../ui/plottingSurface";
import {TextOverlay} from "../ui/textOverlay";
import {HtmlString, Resolution} from "../ui/ui";
import {
    Converters,
    formatNumber, histogram2DAsCsv,
    ICancellable, makeInterval,
    PartialResult,
    saveAs,
    significantDigitsHtml, Two,
} from "../util";
import {AxisData} from "./axisData";
import {NextKReceiver, TableView} from "./tableView";
import {DataRangesReceiver, FilterReceiver} from "./dataRangesReceiver";
import {ChartView} from "./chartView";
import {Dialog, FieldKind} from "../ui/dialog";
import {HeatmapLegendPlot} from "../ui/heatmapLegendPlot";

/**
 * A HeatMapView renders information as a heatmap.
 */
export class HeatmapView extends ChartView<Two<Groups<Groups<number>>>> {
    protected colorLegend: HeatmapLegendPlot;
    protected summary: HTMLElement;
    protected plot: HeatmapPlot;
    protected showMissingData: boolean = false;  // TODO: enable this
    protected legendSurface: HtmlPlottingSurface;
    protected xHistoSurface: PlottingSurface;
    protected xHistoPlot: HistogramPlot;
    protected xPoints: number;
    protected yPoints: number;
    protected readonly viewMenu: SubMenu;
    protected xAxisData: AxisData;
    protected yAxisData: AxisData;
    protected legendDiv: HTMLDivElement;
    protected heatmapDiv: HTMLDivElement;
    protected missingDiv: HTMLDivElement;
    protected confThreshold: number;
    private readonly defaultProvenance: string = "Fron heatmap";

    constructor(remoteObjectId: RemoteObjectId,
                rowCount: number,
                schema: SchemaClass,
                protected samplingRate: number,
                page: FullPage) {
        super(remoteObjectId, rowCount, schema, page, "Heatmap");
        this.topLevel = document.createElement("div");
        this.topLevel.className = "chart";
        this.confThreshold = 2;
        this.viewMenu = new SubMenu([
            {
                text: "refresh",
                action: () => {
                    this.refresh();
                },
                help: "Redraw this view.",
            }, {
                text: "swap axes",
                action: () => this.swapAxes(),
                help: "Draw the heatmap with the same data by swapping the X and Y axes.",
            },  { text: "# buckets...",
                action: () => this.chooseBuckets(),
                help: "Change the number of buckets used to draw this histogram. ",
            }, {
                text: "table",
                action: () => this.showTable(),
                help: "View the data underlying this view as a table.",
            }, {
                text: "histogram",
                action: () => this.histogram(),
                help: "Show this data as a two-dimensional histogram.",
            }, {
                text: "Quartiles vector",
                action: () => this.quartileView(),
                help: "Show this data as a vector of quartiles.",
            }, {
                text: "group by...",
                action: () => this.groupBy(),
                help: "Group data by a third column.",
            }, {
                text: "Confidence threshold...",
                action: () => this.changeThreshold(),
                help: "Specify how much larger than the confidence interval the data must be to be displayed.",
            },
        ]);
        this.menu = new TopMenu([
            this.exportMenu(),
            {text: "View", help: "Change the way the data is displayed.", subMenu: this.viewMenu},
            this.dataset.combineMenu(this, page.pageId),
        ]);

        this.viewMenu.enable("Confidence threshold...", this.isPrivate());
        this.page.setMenu(this.menu);
        this.legendDiv = this.makeToplevelDiv();
        this.heatmapDiv = this.makeToplevelDiv();
        this.missingDiv = this.makeToplevelDiv();
        this.summary = document.createElement("div");
        this.topLevel.appendChild(this.summary);
    }

    private quartileView(): void {
        if (!kindIsNumeric(this.yAxisData.description.kind)) {
            this.page.reportError("Quartiles require a numeric second column");
            return;
        }
        const cds = [this.xAxisData.description, this.yAxisData.description];
        const rr = this.createDataQuantilesRequest(cds, this.page, "QuartileVector");
        rr.invoke(new DataRangesReceiver(this, this.page, rr, this.schema,
            [0, 0], cds, null, this.defaultProvenance,{
                reusePage: false,
                chartKind: "QuartileVector",
            }));
    }

    public changeThreshold(): void {
        const thDialog = new Dialog("Confidence threshold",
            "Change the threshold for the confidence interval.");
        let input = thDialog.addTextField("multiplier", "Multiplier:", FieldKind.Double, this.confThreshold.toString(),
            "Data with value > multiplier * confidence is displayed.");
        input.required = true;
        thDialog.setAction(() => {
            const c = thDialog.getFieldValueAsNumber("multiplier");
            if (c == null) {
                this.page.reportError("Threshold must be a number");
                return;
            }
            this.confThreshold = c;
            this.resize();
        });
        thDialog.show();
    }

    public chooseBuckets(): void {
        const bucketDialog = new Dialog("Set buckets",
            "Change the resolution used to display the heatmap.");

        const chartSize = PlottingSurface.getDefaultChartSize(this.page.getWidthInPixels());
        let input = bucketDialog.addTextField("x_buckets", "X axis buckets:", FieldKind.Integer, null,
            "The number of buckets on X axis.");
        input.min = "1";
        input.max = Math.floor(chartSize.width / Resolution.minDotSize).toString();
        input.value = this.xAxisData.bucketCount.toString();
        input.required = true;

        input = bucketDialog.addTextField("y_buckets", "Y axis buckets:", FieldKind.Integer, null,
            "The number of buckets on Y axis.");
        input.min = "1";
        input.max = Math.floor(chartSize.height / Resolution.minDotSize).toString();
        input.value = this.yAxisData.bucketCount.toString();
        input.required = true;
        bucketDialog.setAction(() => this.changeBuckets(
            bucketDialog.getFieldValueAsInt("x_buckets"),
            bucketDialog.getFieldValueAsInt("y_buckets")));
        bucketDialog.show();
    }

    private changeBuckets(x: number, y: number): void {
        if (x == null || y == null) {
            this.page.reportError("Illegal value");
            return;
        }
        const rr = this.createDataQuantilesRequest(
            [this.xAxisData.description, this.yAxisData.description],
            this.page, "Heatmap");
        rr.invoke(new DataRangesReceiver(
            this, this.page, rr, this.schema, [x, y],
            [this.xAxisData.description, this.yAxisData.description], null,
            this.defaultProvenance, { chartKind: "Heatmap", exact: true, reusePage: true }));
    }

    protected createNewSurfaces(keepColorMap: boolean): void {
        if (this.legendSurface != null)
            this.legendSurface.destroy();
        if (this.surface != null)
            this.surface.destroy();
        if (this.xHistoSurface != null)
            this.xHistoSurface.destroy();

        this.legendSurface = new HtmlPlottingSurface(this.legendDiv, this.page,
            { height: Resolution.legendSpaceHeight * 2 / 3 });
        if (keepColorMap)
            this.colorLegend.setSurface(this.legendSurface);
        else {
            this.colorLegend = new HeatmapLegendPlot(
                this.legendSurface,
                (xl, xr) => this.colorLegend.emphasizeRange(xl, xr));
            this.colorLegend.setColorMapChangeEventListener(
                () => this.updateView(this.data, true));
        }

        this.surface = new HtmlPlottingSurface(this.heatmapDiv, this.page,
            { topMargin: 20, leftMargin: Resolution.heatmapLabelWidth });
        this.plot = new HeatmapPlot(this.surface, this.colorLegend, true);

        if (this.showMissingData) {
            this.xHistoSurface = new HtmlPlottingSurface(
                this.missingDiv, this.page, {
                    topMargin: 0,
                    bottomMargin: 16,
                    height: 100
                });
            this.xHistoPlot = new HistogramPlot(this.xHistoSurface);
        }
    }

    public setAxes(xData: AxisData, yData: AxisData): void {
        this.xAxisData = xData;
        this.yAxisData = yData;
    }

    public getAxisData(event: DragEventKind): AxisData | null {
        switch (event) {
            case "Title":
            case "GAxis":
                return null;
            case "XAxis":
                return this.xAxisData;
            case "YAxis":
                return this.yAxisData;
        }
    }

    protected replaceAxis(pageId: string, eventKind: DragEventKind): void {
        if (this.data == null)
            return;
        const sourceRange = this.getSourceAxisRange(pageId, eventKind);
        if (sourceRange === null)
            return;

        let ranges = [];
        if (eventKind === "XAxis") {
            ranges = [sourceRange, this.yAxisData.dataRange];
        } else if (eventKind === "YAxis") {
            ranges = [this.xAxisData.dataRange, sourceRange];
        } else {
            return;
        }

        const collector = new DataRangesReceiver(this,
            this.page, null, this.schema, [0, 0],  // any number of buckets
            [this.xAxisData.description, this.yAxisData.description], null,
            Converters.eventToString(pageId, eventKind), {
                chartKind: "Heatmap", exact: this.samplingRate >= 1,
                relative: false, pieChart: false, reusePage: true
            });
        collector.run(ranges);
        collector.finished();
    }

    public updateView(data: Two<Groups<Groups<number>>>, keepColorMap: boolean): void {
        this.createNewSurfaces(keepColorMap);
        if (data == null || data.first === null || data.first.perBucket.length === 0) {
            this.page.reportError("No data to display");
            return;
        }

        this.data = data;
        this.xPoints = data.first.perBucket.length;
        this.yPoints = data.first.perBucket[0].perBucket.length;
        if (this.yPoints === 0) {
            this.page.reportError("No data to display");
            return;
        }

        if (this.isPrivate()) {
            const cols = [this.xAxisData.description.name, this.yAxisData.description.name];
            const eps = this.dataset.getEpsilon(cols);
            this.page.setEpsilon(eps, cols);
        }

        // The order of these operations is important
        this.plot.setData(data, this.xAxisData, this.yAxisData, this.schema, this.confThreshold, this.isPrivate());
        if (!keepColorMap) {
            this.colorLegend.setData({first: 1, second: this.plot.getMaxCount() });
        }
        this.colorLegend.draw();
        this.plot.draw();
        if (this.showMissingData) {
            this.xHistoPlot.setHistogram({first: data.first.perMissing, second: null },
                this.samplingRate,
                this.xAxisData, null,
                this.page.dataset.isPrivate(), this.rowCount);
            this.xHistoPlot.draw();
        }

        this.setupMouse();
        this.pointDescription = new TextOverlay(this.surface.getChart(),
            this.surface.getActualChartSize(),
            [this.schema.displayName(this.xAxisData.description.name).displayName,
                this.schema.displayName(this.yAxisData.description.name).displayName, "count"], 40);
        let summary = new HtmlString(formatNumber(this.plot.getVisiblePoints()) + " data points");
        /*
        if (heatmap.missingData !== 0) {
            summary = summary.appendSafeString(", " + formatNumber(heatmap.missingData) + " missing");
        }
        if (heatmap.histogramMissingX.perMissing !== 0) {
            summary = summary.appendSafeString(
                ", " + formatNumber(heatmap.histogramMissingX.perMissing) + " missing Y coordinate");
        }
        if (heatmap.histogramMissingY.perMissing !== 0) {
            summary = summary.appendSafeString(
                ", " + formatNumber(heatmap.histogramMissingY.perMissing) + " missing X coordinate");
        }
         */
        summary = summary.appendSafeString(", " + formatNumber(this.plot.getDistinct()) + " distinct dots");
        if (this.samplingRate < 1.0) {
            summary = summary.appendSafeString(", sampling rate ").append(significantDigitsHtml(this.samplingRate));
        }
        summary.setInnerHtml(this.summary);
    }

    public serialize(): IViewSerialization {
        const ser = super.serialize();
        // noinspection UnnecessaryLocalVariableJS
        const result: HeatmapSerialization = {
            samplingRate: this.samplingRate,
            columnDescription0: this.xAxisData.description,
            columnDescription1: this.yAxisData.description,
            xBucketCount: this.xAxisData.bucketCount,
            yBucketCount: this.yAxisData.bucketCount,
            ...ser,
        };
        return result;
    }

    public static reconstruct(ser: HeatmapSerialization, page: FullPage): IDataView {
        if (ser.columnDescription0 == null || ser.columnDescription1 == null ||
            ser.samplingRate == null || ser.schema == null ||
            ser.xBucketCount == null || ser.yBucketCount == null) {
            return null;
        }
        const schema: SchemaClass = new SchemaClass([]).deserialize(ser.schema);
        const hv = new HeatmapView(ser.remoteObjectId, ser.rowCount, schema, ser.samplingRate, page);
        hv.setAxes(
            new AxisData(ser.columnDescription0, null, ser.xBucketCount),
            new AxisData(ser.columnDescription1, null, ser.yBucketCount));
        return hv;
    }

    // Draw this as a 2-D histogram
    public histogram(): void {
        const cds = [this.xAxisData.description, this.yAxisData.description];
        const rr = this.createDataQuantilesRequest(cds, this.page, "2DHistogram");
        rr.invoke(new DataRangesReceiver(this, this.page, rr, this.schema,
            [0, 0], cds, null, this.defaultProvenance, {
            reusePage: false,
            chartKind: "2DHistogram",
            exact: true
        }));
    }

    public groupBy(): void {
        const columns: DisplayName[] = this.schema.displayNamesExcluding(
            [this.xAxisData.description.name, this.yAxisData.description.name]);
        this.chooseTrellis(columns);
    }

    public export(): void {
        const lines: string[] = histogram2DAsCsv(
            this.data.first, this.schema, [this.xAxisData, this.yAxisData]);
        const fileName = "heatmap.csv";
        saveAs(fileName, lines.join("\n"));
    }

    protected showTrellis(colName: DisplayName): void {
        const groupBy = this.schema.findByDisplayName(colName);
        const cds: IColumnDescription[] = [this.xAxisData.description,
                                           this.yAxisData.description, groupBy];
        const rr = this.createDataQuantilesRequest(cds, this.page, "TrellisHeatmap");
        rr.invoke(new DataRangesReceiver(this, this.page, rr, this.schema,
            [0, 0, 0], cds, null, this.defaultProvenance,{
            reusePage: false, chartKind: "TrellisHeatmap", exact: true
        }));
    }

    protected getCombineRenderer(title: PageTitle):
        (page: FullPage, operation: ICancellable<RemoteObjectId>) => BaseReceiver {
        return (page: FullPage, operation: ICancellable<RemoteObjectId>) => {
            return new FilterReceiver(title, [this.xAxisData.description, this.yAxisData.description],
                this.schema, [0, 0], page, operation, this.dataset, {
                exact: true, chartKind: "Heatmap", reusePage: false,
            });
        };
    }

    // show the table corresponding to the data in the heatmap
    public showTable(): void {
        const order =  new RecordOrder([ {
            columnDescription: this.xAxisData.description,
            isAscending: true,
        }, {
            columnDescription: this.yAxisData.description,
            isAscending: true,
        }]);
        const page = this.dataset.newPage(new PageTitle("Table", "from heatmap"), this.page);
        const table = new TableView(this.remoteObjectId, this.rowCount, this.schema, page);
        page.setDataView(table);
        table.schema = this.schema;
        const rr = table.createNextKRequest(order, null, Resolution.tableRowsOnScreen);
        rr.invoke(new NextKReceiver(page, table, rr, false, order, null));
    }

    public swapAxes(): void {
        const cds: IColumnDescription[] = [
            this.yAxisData.description, this.xAxisData.description];
        const rr = this.createDataQuantilesRequest(cds, this.page, "Heatmap");
        rr.invoke(new DataRangesReceiver(this, this.page, rr, this.schema,
            [0, 0], cds, null, "swap axes",{
            chartKind: "Heatmap",
            exact: this.samplingRate >= 1,
            reusePage: true
        }));
    }

    public refresh(): void {
        const ranges = [this.xAxisData.dataRange, this.yAxisData.dataRange];
        const collector = new DataRangesReceiver(this,
            this.page, null, this.schema, [this.xAxisData.bucketCount, this.yAxisData.bucketCount],
            [this.xAxisData.description, this.yAxisData.description], this.page.title, null,{
                chartKind: "Heatmap", exact: this.samplingRate >= 1, reusePage: true,
            });
        collector.run(ranges);
        collector.finished();
    }

    public resize(): void {
        if (this.data == null)
            return;
        this.updateView(this.data, true);
    }

    protected onMouseMove(): void {
        if (this.xAxisData.axis == null) {
            // not yet setup
            return;
        }

        const position = d3mouse(this.surface.getChart().node());
        const mouseX = position[0];
        const mouseY = position[1];
        const xs = this.xAxisData.invert(mouseX);
        const ys = this.yAxisData.invert(mouseY);

        const value = this.plot.getCount(mouseX, mouseY);
        this.pointDescription.update([xs, ys, makeInterval(value)], mouseX, mouseY);
        this.colorLegend.highlight(value[0], value[1]);
    }

    protected dragStart(): void {
        this.dragStartRectangle();
    }

    protected dragMove(): boolean {
        return this.dragMoveRectangle();
    }

    protected dragEnd(): boolean {
        if (!super.dragEnd())
            return false;
        const position = d3mouse(this.surface.getCanvas().node());
        const x = position[0];
        const y = position[1];
        this.selectionCompleted(this.selectionOrigin.x, x, this.selectionOrigin.y, y);
        return true;
    }

    /**
     * Selection has been completed.  The mouse coordinates are within the canvas.
     */
    private selectionCompleted(xl: number, xr: number, yl: number, yr: number): void {
        const f = this.filterSelectionRectangle(xl, xr, yl, yr, this.xAxisData, this.yAxisData);
        if (f == null)
            return;
        const rr = this.createFilterRequest(f);
        const renderer = new FilterReceiver(new PageTitle(this.page.title.format,
            Converters.filterArrayDescription(f)),
            [this.xAxisData.description, this.yAxisData.description],
            this.schema, [0, 0], this.page, rr, this.dataset, {
            exact: this.samplingRate >= 1, chartKind: "Heatmap", reusePage: false,
        });
        rr.invoke(renderer);
    }
}

/**
 * Renders a heatmap
 */
export class HeatmapReceiver extends Receiver<Two<Groups<Groups<number>>>> {
    protected heatmap: HeatmapView;

    constructor(title: PageTitle,
                page: FullPage,
                remoteTable: TableTargetAPI,
                protected rowCount: number,
                protected schema: SchemaClass,
                protected axisData: AxisData[],
                protected samplingRate: number,
                operation: ICancellable<Groups<Groups<number>>>,
                protected reusePage: boolean) {
        super(reusePage ? page : page.dataset.newPage(title, page), operation, "histogram");
        this.heatmap = new HeatmapView(
            remoteTable.remoteObjectId, rowCount, schema,
            this.samplingRate, this.page);
        this.heatmap.setAxes(axisData[0], axisData[1]);
        this.page.setDataView(this.heatmap);
    }

    public onNext(value: PartialResult<Two<Groups<Groups<number>>>>): void {
        super.onNext(value);
        if (value == null) {
            return;
        }

        this.heatmap.updateView(value.data, false);
    }

    public onCompleted(): void {
        super.onCompleted();
        this.heatmap.updateCompleted(this.elapsedMilliseconds());
    }
}
