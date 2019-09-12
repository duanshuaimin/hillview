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

import {IViewSerialization} from "../datasetView";
import {
    allContentsKind,
    BasicColStats,
    ColumnSortOrientation,
    kindIsString,
    NextKList,
    RecordOrder,
    RemoteObjectId,
    Schema,
} from "../javaBridge";
import {SchemaClass} from "../schemaClass";
import {IDataView} from "../ui/dataview";
import {Dialog, FieldKind} from "../ui/dialog";
import {FullPage, PageTitle} from "../ui/fullPage";
import {ContextMenu, SubMenu, TopMenu} from "../ui/menu";
import {TabularDisplay} from "../ui/tabularDisplay";
import {Resolution} from "../ui/ui";
import {
    cloneToSet,
    convertToStringFormat, formatNumber,
    ICancellable,
    PartialResult,
    significantDigits,
    convertToInterval
} from "../util";
import {TableView} from "./tableView";
import {TSViewBase} from "./tsViewBase";
import {BaseReceiver} from "../tableTarget";
import {Receiver, RpcRequest} from "../rpc";

/**
 * This class is used to browse through the columns of a table schema
 * and select columns from them.
 */
export class SchemaView extends TSViewBase {
    protected display: TabularDisplay;
    protected contextMenu: ContextMenu;
    protected summary: HTMLElement;
    protected stats: Map<string, BasicColStats>;
    protected nameDialog: Dialog;
    protected typeDialog: Dialog;

    constructor(remoteObjectId: RemoteObjectId,
                page: FullPage,
                rowCount: number,
                schema: SchemaClass) {
        super(remoteObjectId, rowCount, schema, page, "Schema");
        this.stats = null;
        this.topLevel = document.createElement("div");
        this.contextMenu = new ContextMenu(this.topLevel);
        const viewMenu = new SubMenu([{
            text: "Selected columns",
            action: () => this.showTable(),
            help: "Show the data using a tabular view containing the selected columns.",
        }]);

        /* Dialog box for selecting columns based on name */
        this.nameDialog = new Dialog("Select by name",
            "Allows selecting/deselecting columns by name using regular expressions");
        const name = this.nameDialog.addTextField("selected", "Name (regex)", FieldKind.String, "",
            "Names of columns to select (regular expressions allowed)");
        name.required = true;
        const actions: string[] = ["Add", "Remove"];
        this.nameDialog.addSelectField("action", "Action", actions, "Add",
            "Add to or Remove from current selection");
        this.nameDialog.setAction(() => {
            const regExp: RegExp = new RegExp(this.nameDialog.getFieldValue("selected"));
            const action: string = this.nameDialog.getFieldValue("action");
            this.nameAction(regExp, action);
            this.display.highlightSelectedRows();
            this.selectedSummary();
        });

        /* Dialog box for selecting columns based on type*/
        this.typeDialog = new Dialog("Select by type", "Allows selecting/deselecting columns based on type");
        this.typeDialog.addSelectField("selectedType", "Type",
            allContentsKind, "String",
            "Type of columns you wish to select");
        this.typeDialog.addSelectField("action", "Action", actions, "Add",
            "Add to or Remove from current selection");
        this.typeDialog.setCacheTitle("SchemaTypeDialog");
        this.typeDialog.setAction(() => {
            const selectedType: string = this.typeDialog.getFieldValue("selectedType");
            const action: string = this.typeDialog.getFieldValue("action");
            this.typeAction(selectedType, action);
            this.display.highlightSelectedRows();
            this.selectedSummary();
        });

        const statDialog = new Dialog("Select by statistics",
            "Allow selecting/deselecting columns based on statistics\n" +
            "(only works on the columns whose statistics have been computed).");
        statDialog.addBooleanField("selectEmpty", "All data missing", true,
            "Select all columns that only have missing data.");
        statDialog.addTextField("lowStder", "stddev/mean threshold", FieldKind.Double, ".1",
            "Select all columns where stddev/mean < threshold.  If the mean is zero the columns is never selected.");
        statDialog.setCacheTitle("SchemaStatDialog");
        statDialog.setAction(() => {
            const selE: boolean = statDialog.getBooleanValue("selectEmpty");
            const stddev: number = statDialog.getFieldValueAsNumber("lowStder");
            this.statAction(selE, stddev);
            this.display.highlightSelectedRows();
            this.selectedSummary();
        });

        const selectMenu = new SubMenu([{
            text: "By Name",
            action: () => this.nameDialog.show(),
            help: "Select Columns by name.",
        }, {
            text: "By Type",
            action: () => this.typeDialog.show(),
            help: "Select Columns by type.",
        }, {
            text: "By statistics",
            action: () => statDialog.show(),
            help: "Select columns by statistics."
        }]);
        const menu = new TopMenu([
            // this.saveAsMenu(),
            {text: "View", subMenu: viewMenu, help: "Change the way the data is displayed."},
            {text: "Select", subMenu: selectMenu, help: "Select columns based on attributes."},
            this.chartMenu(),
        ]);
        this.page.setMenu(menu);
        this.topLevel.appendChild(document.createElement("br"));
        this.display = new TabularDisplay();
        this.topLevel.appendChild(this.display.getHTMLRepresentation());
        this.summary = document.createElement("div");
        this.topLevel.appendChild(this.summary);
    }

    public static reconstruct(ser: IViewSerialization, page: FullPage): IDataView {
        const schema = new SchemaClass([]).deserialize(ser.schema);
        if (schema == null)
            return null;
        return new SchemaView(ser.remoteObjectId, page, ser.rowCount, schema);
    }

    public refresh(): void {
        this.show(0);
    }

    public show(elapsedMs: number): void {
        this.display.clear();
        const names = ["#", "Name", "Type"];
        const descriptions = ["Column number", "Column name", "Type of data stored within the column"];
        if (this.stats != null) {
            // This has to be kept in sync with basicColStats in TableTarget.java
            // There we ask for two moments.
            names.push("Min", "Max", "Average", "Stddev", "Missing");
            descriptions.push("Minimum value", "Maximum value", "Average value",
                "Standard deviation", "Number of missing elements");
        }
        this.display.setColumns(names, descriptions);
        this.display.addRightClickHandler("Name", (e: MouseEvent) => {
            e.preventDefault();
            this.nameDialog.show();
        });
        this.display.addRightClickHandler("Type", (e: MouseEvent) => {
            e.preventDefault();
            this.typeDialog.show();
        });
        this.displayRows();
        this.display.getHTMLRepresentation().setAttribute("overflow-x", "hidden");
        if (this.rowCount != null)
            this.summary.textContent = formatNumber(this.rowCount) + " rows";
        this.page.setDataView(this);
        this.page.reportTime(elapsedMs);
    }

    private displayRows(): void {
        for (let i = 0; i < this.schema.length; i++) {
            const cd = this.schema.get(i);
            const data = [
                (i + 1).toString(),
                this.schema.displayName(cd.name),
                cd.kind.toString()];
            if (this.stats != null) {
                const cs = this.stats.get(cd.name);
                if (cs != null) {
                    if (cs.presentCount === 0) {
                        data.push("", "", "", "");
                    } else {
                        if (kindIsString(cd.kind)) {
                            data.push(cs.minString, cs.maxString, "", "");
                        } else {
                            let avg;
                            let stddev;
                            if (cd.kind === "Date") {
                                avg = convertToStringFormat(cs.moments[0], "Date");
                                stddev = convertToInterval(cs.moments[1]);
                            } else {
                                avg = significantDigits(cs.moments[0]);
                                stddev = significantDigits(cs.moments[1]);
                            }
                            data.push(
                                convertToStringFormat(cs.min, cd.kind),
                                convertToStringFormat(cs.max, cd.kind),
                                avg, stddev);
                        }
                    }
                    data.push(formatNumber(cs.missingCount));
                } else {
                    data.push("", "", "", "", "");
                }
            }
            const row = this.display.addRow(data);
            row.oncontextmenu = (e) => this.createAndShowContextMenu(e);
        }
    }

    public createAndShowContextMenu(e: MouseEvent): void {
        if (e.ctrlKey && (e.button === 1)) {
            // Ctrl + click is interpreted as a right-click on macOS.
            // This makes sure it's interpreted as a column click with Ctrl.
            return;
        }
        this.contextMenu.clear();
        const selectedCount = this.display.selectedRows.size();
        this.contextMenu.addItem({
            text: "Drop",
            action: () => this.dropColumns(),
            help: "Drop the selected columns from the view." }, true);
        this.contextMenu.addItem({
            text: "Show as table",
            action: () => this.showTable(),
            help: "Show the selected columns in a tabular view." }, true);
        this.contextMenu.addItem({
            text: "Histogram",
            action: () => this.histogramSelected(),
            help: "Plot the data in the selected columns as a histogram.  Applies to one or two columns only. " +
            "The data cannot be of type String.",
        }, selectedCount >= 1 && selectedCount <= 2);
        this.contextMenu.addItem({
            text: "Heatmap",
            action: () => this.heatmapSelected(),
            help: "Plot the data in the selected columns as a heatmap or as a Trellis plot of heatmaps. " +
            "Applies to two columns only.",
        }, selectedCount === 2);
        this.contextMenu.addItem({
            text: "Trellis histograms",
            action: () => this.trellisSelected(false),
            help: "Plot the data in the selected columns as a Trellis plot of histograms. " +
                "Applies to two or three columns only.",
        }, selectedCount >= 2 && selectedCount <= 3);
        this.contextMenu.addItem({
            text: "Trellis heatmaps",
            action: () => this.trellisSelected(true),
            help: "Plot the data in the selected columns as a Trellis plot of heatmaps. " +
                "Applies to three columns only.",
        }, selectedCount === 3);
        this.contextMenu.addItem({
            text: "Estimate distinct elements",
            action: () => this.hLogLog(),
            help: "Compute an estimate of the number of different values that appear in the selected column.",
        }, selectedCount === 1);
        this.contextMenu.addItem({
            text: "Filter...",
            action: () => {
                const colName = this.getSelectedColNames()[0];
                const cd = this.schema.find(colName);
                const so: ColumnSortOrientation = {
                    columnDescription: cd, isAscending: true,
                };
                this.showFilterDialog(colName, new RecordOrder([so]), Resolution.tableRowsOnScreen);
            },
            help : "Eliminate data that matches/does not match a specific value.",
        }, selectedCount === 1);
        this.contextMenu.addItem({
            text: "Compare...",
            action: () => {
                const colName = this.getSelectedColNames()[0];
                const cd = this.schema.find(colName);
                const so: ColumnSortOrientation = {
                    columnDescription: cd, isAscending: true,
                };
                this.showCompareDialog(this.schema.displayName(colName), new RecordOrder([so]),
                    Resolution.tableRowsOnScreen);
            },
            help : "Eliminate data that matches/does not match a specific value.",
        }, selectedCount === 1);
        this.contextMenu.addItem({
            text: "Create column in JS...",
            action: () => this.createJSColumnDialog(new RecordOrder([]), Resolution.tableRowsOnScreen),
            help: "Add a new column computed from the selected columns.",
        }, true);
        this.contextMenu.addItem({
            text: "Rename...",
            action: () => this.renameColumn(),
            help: "Give a new name to this column.",
        }, selectedCount === 1);
        this.contextMenu.addItem({
            text: "Frequent Elements...",
            action: () => this.heavyHittersDialog(),
            help: "Find the values that occur most frequently in the selected columns.",
        }, true);
        this.contextMenu.addItem({
            text: "Basic statistics",
            action: () => this.getBasicStats(this.getSelectedColNames()),
            help: "Get basic statistics for the selected columns.",
        }, true);
        this.contextMenu.show(e);
    }

    protected getBasicStats(cols: string[]): void {
        if (cols.length === 0)
            return;
        const rr = this.createBasicColStatsRequest(cols);
        rr.invoke(new BasicColStatsReceiver(this.getPage(), this, cols, rr));
    }

    public updateStats(cols: string[], stats: BasicColStats[]): void {
        console.assert(cols.length === stats.length);
        if (this.stats == null)
            this.stats = new Map<string, BasicColStats>();
        for (let i = 0; i < cols.length; i++) {
            this.stats.set(cols[i], stats[i]);
        }
        this.show(0);
    }

    public resize(): void {
        this.show(0);
    }

    private dropColumns(): void {
        const selected = cloneToSet(this.getSelectedColNames());
        this.schema = this.schema.filter((c) => !selected.has(c.name));
        this.show(0);
    }

    private nameAction(regExp: RegExp, action: string): void {
        for (let i = 0; i < this.schema.length; i++) {
            if (this.schema.displayName(this.schema.get(i).name).match(regExp)) {
                if (action === "Add")
                    this.display.selectedRows.add(i);
                else if (action === "Remove")
                    this.display.selectedRows.delete(i);
            }
        }
    }

    // Action triggered by the statistics selection menu.
    private statAction(allE: boolean, thresh: number): void {
        for (let i = 0; i < this.schema.length; i++) {
            const name = this.schema.get(i).name;
            const stat = this.stats.get(name);
            if (stat == null)
                continue;

            if (allE && stat.presentCount === 0)
                this.display.selectedRows.add(i);
            if (stat.moments[0] > .001 &&
                (stat.moments[1] / stat.moments[0]) < thresh)
                this.display.selectedRows.add(i);
        }
    }

    protected getCombineRenderer(title: PageTitle):
        (page: FullPage, operation: ICancellable<RemoteObjectId>) => BaseReceiver {
        return null;  // not used
    }

    public getSelectedColCount(): number {
        return this.display.selectedRows.size();
    }

    public getSelectedColNames(): string[] {
        const colNames: string[] = [];
        this.display.selectedRows.getStates().forEach((i) => colNames.push(this.schema.get(i).name));
        return colNames;
    }

    private selectedSummary(): void {
        this.page.reportError(this.display.selectedRows.size().toString() + " are selected");
    }

    /**
     * @param {string} selectedType: A type of column, from ContentsKind.
     * @param {string} action: Either Add or Remove.
     * This method updates the set of selected columns by adding/removing all columns of selectedType.
     */
    private typeAction(selectedType: string, action: string): void {
        for (let i = 0; i < this.schema.length; i++) {
            const kind = this.schema.get(i).kind;
            if (kind === selectedType) {
                if (action === "Add")
                    this.display.selectedRows.add(i);
                else if (action === "Remove")
                    this.display.selectedRows.delete(i);
            }
        }
    }

    /**
     * This method displays the table consisting of only the columns contained in the schema above.
     */
    private showTable(): void {
        const newPage = this.dataset.newPage(new PageTitle("Selected columns"), this.page);
        const selected = this.display.getSelectedRows();
        const newSchema = this.schema.filter((c) => selected.has(this.schema.columnIndex(c.name)));
        const tv = new TableView(this.remoteObjectId, this.rowCount, newSchema, newPage);
        newPage.setDataView(tv);
        const nkl: NextKList = {
            rowsScanned: this.rowCount,
            startPosition: 0,
            rows: [],
        };
        tv.updateView(nkl, false, new RecordOrder([]), null);
        tv.updateCompleted(0);
    }
}

/**
 * Receives a set of basic column statistics and updates the SchemaView to display them.
 */
class BasicColStatsReceiver extends Receiver<BasicColStats[]> {
    constructor(page: FullPage,
                public sv: SchemaView,
                public cols: string[],
                rr: RpcRequest<BasicColStats[]>) {
        super(page, rr, "Get basic statistics");
    }

    public onNext(value: PartialResult<BasicColStats[]>): void {
        super.onNext(value);
        if (value.data != null)
            this.sv.updateStats(this.cols, value.data);
    }
}
