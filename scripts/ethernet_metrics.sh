#!/bin/bash

# ----------------------------------------------------------------------------
# Description
# ----------------------------------------------------------------------------

# Record transferred bytes in redis as raw data
# Calculate throughput of given period(15min) as sample data
# Get metrics of sample data including mean/75p/90p

CMD=$(basename $0)
: ${FIREWALLA_HOME:=/home/pi/firewalla}
: ${INTERVAL_RAW_SEC:=10}
: ${INTERVAL_STAT_SEC:=900}
: ${EXPIRE_PERIOD:='60 seconds'}
KEY_PREFIX=metric:throughput
KEY_PREFIX_RAW=$KEY_PREFIX:raw
KEY_PREFIX_STAT=$KEY_PREFIX:stat

err(){
    msg="$@"
    echo "ERROR: $msg" >&2
}

get_eths() {
    ls -l /sys/class/net | awk '/pci/ {print $9}'
}

logrun() {
    echo "> $@"
    rc=$(eval "$@")
}

record_raw_data() {
    ethx=$1
    read rx0 tx0 < <( awk "/$ethx/ {print \$2\" \"\$10}" /proc/net/dev )
    while true; do
        # read data from system
        sleep $INTERVAL_RAW_SEC
        read rx1 tx1 < <( awk "/$ethx/ {print \$2\" \"\$10}" /proc/net/dev )
        ts=$(date +%s)
        let rxd=(rx1-rx0)/INTERVAL_RAW_SEC
        let txd=(tx1-tx0)/INTERVAL_RAW_SEC
        rx0=$rx1; tx0=$tx1
        logrun redis-cli zadd $KEY_PREFIX_RAW:$ethx:rx $rxd $ts
        logrun redis-cli zadd $KEY_PREFIX_RAW:$ethx:tx $txd $ts
    done
}

clean_scan() {
    cursor=$1;shift
    ts_oldest=$1;shift
    redis_key=$1;shift

    redis-cli zscan $redis_key $cursor | {
        read new_cursor
        while read value
        do
            read score
            if [[ $value -lt $ts_oldest ]]
            then
                logrun redis-cli zrem $redis_key $value
            fi
        done
        if [[ $new_cursor -ne 0 ]]
        then
            clean_scan $new_cursor $ts_oldest $redis_key
        fi
    }
}

clean_old_data() {
    redis_key=$1
    ts_oldest=$(date -d "-$EXPIRE_PERIOD" +%s)
    clean_scan 0 $ts_oldest $redis_key
}

calc_metrics() {
    key_suffix=$1:$2
    while true
    do
        # clean out-of-date data
        clean_old_data $KEY_PREFIX_RAW:$key_suffix

        # calculate stats
        count=$(redis-cli zcard $KEY_PREFIX_RAW:$key_suffix)
        if [[ $count -gt 0 ]]
        then
            let idx_median=count/2
            let idx_pt75=(count*75)/100
            let idx_pt90=(count*90)/100
            val_min=$( redis-cli zrangebyscore $KEY_PREFIX_RAW:$key_suffix 0 +inf withscores limit 0 1 | tail -1 )
            val_median=$( redis-cli zrangebyscore $KEY_PREFIX_RAW:$key_suffix 0 +inf withscores limit $idx_median 1 | tail -1 )
            val_max=$( redis-cli zrevrangebyscore $KEY_PREFIX_RAW:$key_suffix +inf 0 withscores limit 0 1 | tail -1 )
            val_pt75=$( redis-cli zrangebyscore $KEY_PREFIX_RAW:$key_suffix 0 +inf withscores limit $idx_pt75 1 | tail -1 )
            val_pt90=$( redis-cli zrangebyscore $KEY_PREFIX_RAW:$key_suffix 0 +inf withscores limit $idx_pt90 1 | tail -1 )

            logrun redis-cli hmset $KEY_PREFIX_STAT:$key_suffix \
                min    $val_min \
                median $val_median \
                max    $val_max \
                pt75   $val_pt75 \
                pt90   $val_pt90
        fi
        sleep $INTERVAL_STAT_SEC
    done
    return 0
}

# ----------------------------------------------------------------------------
# MAIN goes here
# ----------------------------------------------------------------------------

# start recording raw data
for ethx in $(get_eths)
do
    record_raw_data $ethx &
done

# calculate stat data
for ethx in $(get_eths)
do
    for rt in rx tx
    do
        calc_metrics $ethx $rt &
    done
done

wait
