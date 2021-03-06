package org.hillview.table;

import org.hillview.dataset.api.IJsonSketchResult;

public class FileSizeInfo implements IJsonSketchResult {
    /**
     * Total number of files.
     */
    public int fileCount;
    /**
     * Total bytes in all the files.
     */
    public long totalSize;

    public FileSizeInfo(int count, long size) {
        this.fileCount = count;
        this.totalSize = size;
    }

    public FileSizeInfo() {
        this(0, 0);
    }
}
