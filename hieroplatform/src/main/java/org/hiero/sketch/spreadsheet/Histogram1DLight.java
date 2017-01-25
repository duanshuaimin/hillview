package org.hiero.sketch.spreadsheet;

import org.checkerframework.checker.nullness.qual.NonNull;
import org.hiero.sketch.table.api.IColumn;
import org.hiero.sketch.table.api.IMembershipSet;
import org.hiero.sketch.table.api.IRowIterator;
import org.hiero.sketch.table.api.IStringConverter;

import java.util.Random;

/**
 * One dimensional histogram where buckets are just longs and not a full object.
 */
public class Histogram1DLight {
    private final long[] buckets;
    private long missingData;
    private long outOfRange;
    private final IBucketsDescription1D bucketDescription;
    private boolean initialized;

    public Histogram1DLight(final @NonNull IBucketsDescription1D bucketDescription) {
        this.bucketDescription = bucketDescription;
        this.buckets = new long[bucketDescription.getNumOfBuckets()]; //default by java initialized to zero
        this.initialized = false;
    }

    public void createSampleHistogram(final IColumn column, final IMembershipSet membershipSet,
            final IStringConverter converter, double sampleRate) {
        this.createHistogram(column, membershipSet.sample(sampleRate), converter);
    }

    public void createSampleHistogram(final IColumn column, final IMembershipSet membershipSet,
                                      final IStringConverter converter, double sampleRate, long seed) {
        this.createHistogram(column, membershipSet.sample(sampleRate, seed), converter);
    }

    /**
     * @param val already as double to be added to the buckets.
     */
    public void addValue(final double val) {
        this.initialized = true;
        int index = this.bucketDescription.indexOf(val);
        if (index >= 0)
            this.buckets[index]++;
        else this.outOfRange++;
    }

    /**
     * Creates the histogram explicitly and in full. Should be called at most once.
     */
    public void createHistogram(final IColumn column, final IMembershipSet membershipSet,
                                final IStringConverter converter ) {
        if (this.initialized) //a histogram had already been created
            throw new IllegalAccessError("A histogram cannot be created twice");
        this.initialized = true;
        final IRowIterator myIter = membershipSet.getIterator();
        int currRow = myIter.getNextRow();
        while (currRow >= 0) {
            if (column.isMissing(currRow))
                this.missingData++;
            else {
                double val = column.asDouble(currRow,converter);
                int index = this.bucketDescription.indexOf(val);
                if (index >= 0)
                    this.buckets[index]++;
                else this.outOfRange++;
            }
            currRow = myIter.getNextRow();
        }
    }
    public int getNumOfBuckets() { return this.bucketDescription.getNumOfBuckets(); }

    public long getMissingData() { return this.missingData; }

    public long getOutOfRange() { return this.outOfRange; }

    /**
     * @return the index's bucket count
     */
    public long getCount(final int index) { return this.buckets[index]; }

    /**
     * @param  otherHistogram with the same bucketDescription
     * @return a new Histogram which is the union of this and otherHistogram
     */
    public Histogram1DLight union( @NonNull Histogram1DLight otherHistogram) {
        if (!this.bucketDescription.equals(otherHistogram.bucketDescription))
            throw new IllegalArgumentException("Histogram union without matching buckets");
        Histogram1DLight unionH = new Histogram1DLight(this.bucketDescription);
        unionH.initialized = true;
        for (int i = 0; i < unionH.bucketDescription.getNumOfBuckets(); i++)
            unionH.buckets[i] = this.buckets[i] + otherHistogram.buckets[i];
        unionH.missingData = this.missingData + otherHistogram.missingData;
        unionH.outOfRange = this.outOfRange + otherHistogram.outOfRange;
        return unionH;
    }
}