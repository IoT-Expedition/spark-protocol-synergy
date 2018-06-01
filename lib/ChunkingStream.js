/*
*   Copyright (c) 2015 Particle Industries, Inc.  All rights reserved.
*
*   This program is free software; you can redistribute it and/or
*   modify it under the terms of the GNU Lesser General Public
*   License as published by the Free Software Foundation, either
*   version 3 of the License, or (at your option) any later version.
*
*   This program is distributed in the hope that it will be useful,
*   but WITHOUT ANY WARRANTY; without even the implied warranty of
*   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
*   Lesser General Public License for more details.
*
*   You should have received a copy of the GNU Lesser General Public
*   License along with this program; if not, see <http://www.gnu.org/licenses/>.
*/


var Transform = require('stream').Transform;
var logger = require('../lib/logger.js');
const SYNC_BYTES = 0xff;

/**

 Our job here is to accept messages in whole chunks, and put their length in front
 as we send them out, and parse them back into those size chunks as we read them in.

 **/

var ChunkingUtils = {
    MSG_LENGTH_BYTES: 2,
    msgLengthBytes: function (msg) {
        //that.push(ciphertext.length);
        //assuming a maximum encrypted message length of 65K, lets write an unsigned short int before every message,
        //so we know how much to read out.

        if (!msg) {
            //logger.log('msgLengthBytes - message was empty');
            return null;
        }

        var len = msg.length, // the len should be 16bytes.
        lenBuf = new Buffer(ChunkingUtils.MSG_LENGTH_BYTES);

        lenBuf[0] = len >>> 8; // it is 0 ==> 0x00
        lenBuf[1] = len & 255; // it is 16 ==> 0x10

        //logger.log("outgoing message length was " + len);
        return lenBuf;
    }
};


var ChunkingStream = function (options) {
    Transform.call(this, options);
    this.outgoing = !!options.outgoing;
    this.incomingBuffer = null;
    this.incomingIdx = -1;
};

ChunkingStream.INCOMING_BUFFER_SIZE = 1024;

ChunkingStream.prototype = Object.create(Transform.prototype, { constructor: { value: ChunkingStream }});
ChunkingStream.prototype._transform = function (chunk, encoding, callback) {

    if (this.outgoing) {
        //we should be passed whole messages here.
        //write our length first, then message, then bail.

        var headerlength = ChunkingUtils.msgLengthBytes(chunk);
        this.push( Buffer.concat([ headerlength, chunk ]));
        process.nextTick(callback);
    }
    else {
        //collect chunks until we hit an expected size, and then trigger a readable
        try {
            this.process(chunk, callback);
        }
        catch(ex) {
            logger.error("ChunkingStream error!: " + ex);
        }

    }
};

/**
 *
 * @author Chen Chen, Sudershan Boovaraghavan and Abhijit Hota
 * @description: revised by SynergyLabs @ Carnegie Mellon University (2018).
 *
 * @param chunk
 * @param callback
 */
ChunkingStream.prototype.process = function(chunk, callback) {

    if (!chunk) {

        /**
         * Callback is required so that when a chunk is null the tick stack does not get blocked
         */
        callback();
        //process.nextTick(callback);
        return;
    }
    //logger.log("chunk received ", chunk.length, chunk.toString('hex'));

    var isNewMessage = (this.incomingIdx == -1); //if the incoming index is -1, this means it may be a new message.

    var startIdx = 0;


    /**
     *
     * @author Chen Chen, Sudershan Boovaraghavan and Abhijit Hota
     * @description: revised by SynergyLabs @ Carnegie Mellon University (2018).
     *
     *
     * Finding the sync bytes in the buffer so as to read the packet information from that
     * location onward.
     */

    if (chunk[2] == SYNC_BYTES) {
        this.incomingBuffer = null;
        this.incomingIdx = -1;
        this.expectedLength = -1;
        isNewMessage = true;
    }

    if (isNewMessage) {

        //This obtains the data length of the payload.
        this.expectedLength = ((chunk[0] << 8) + chunk[1]);


        // Verify the start of the data buffer using these SyncBytes
        if (chunk[2] != SYNC_BYTES) {

            /* if sync byte doesn't match */
            var isValidChunk = false;

            /* if the third element is not equal to the sync bytes, then continue reading the
             * buffer until you read the correct byte.
             *
             */
            for (var i = 0; i < chunk.length - 2; ++i) {
                if (chunk[i + 2] == SYNC_BYTES) {
                    chunk = chunk.slice(i);
                    isValidChunk = true;
                    break;
                }
            }

            this.incomingBuffer = null;
            this.incomingIdx = -1;
            this.expectedLength = -1;

            // If the packet is wrong ie the sync bytes are not found, then skip the current on
            // and go on to the next.
            // if alignement cannot be found in received chunk, the receive next chunk
            if (!isValidChunk) {
                chunk = null;
                callback();
                return;
            } else {
                this.expectedLength = ((chunk[0] << 8) + chunk[1]);
            }
        }


        //if we don't have a buffer, make one as big as we will need.
        this.incomingBuffer = new Buffer(this.expectedLength);
        this.incomingIdx = 0;
        startIdx = 3;   //skip the first 3 bytes, datalen (2bytes) + SyncBytes [1bytes]
        //logger.log('hoping for message of length ' + this.expectedLength);
    }

    var remainder = null;
    var bytesLeft = this.expectedLength - this.incomingIdx;
    var endIdx = startIdx + bytesLeft;
    if (endIdx > chunk.length) {
        endIdx = chunk.length;
    }
    //startIdx + Math.min(chunk.length - startIdx, bytesLeft);
    var start_idx = startIdx;
    var end_idx = endIdx;

    if (startIdx < endIdx) {
        //logger.log('copying to incoming, starting at ', this.incomingIdx, startIdx, endIdx);
        if (this.incomingIdx >= this.incomingBuffer.length) {
            logger.log("hmm, shouldn't end up here.");
        }
        chunk.copy(this.incomingBuffer, this.incomingIdx, startIdx, endIdx);
    }
    this.incomingIdx += endIdx - startIdx;

    end_idx = endIdx;
    chunkLen = chunk.length;   // remainder chunking wait to be processed

    if (endIdx < chunk.length) {
        remainder = new Buffer(chunk.length -  endIdx);
        chunk.copy(remainder, 0, endIdx, chunk.length);
    }

    var inxoming_idx = this.incomingIdx;
    var expect_length = this.expectedLength;
    if (this.incomingIdx == this.expectedLength) {

        //logger.log("received msg of length" + this.incomingBuffer.length, this.incomingBuffer.toString('hex'));
        this.push(this.incomingBuffer);
        this.incomingBuffer = null;
        this.incomingIdx = -1;
        this.expectedLength = -1;


        /**
         * If remainder is not null, which means the recursive functions is called againt to add more
         * infotmation to the buffer.
         */
        if (remainder != null) {
            this.process(remainder, callback);
        } else {
            chunk = null;
        }
    }
    else {
        //logger.log('fell through ', this.incomingIdx, ' and ', this.expectedLength, ' remainder ', (remainder) ? remainder.length : 0);
        process.nextTick(callback); // got the next step.
        callback = null;    //yeah, don't call that twice.
        return;
    }

    if (!remainder && callback) {
        process.nextTick(callback);
        callback = null;    //yeah, don't call that twice.
    }
};


module.exports = ChunkingStream;