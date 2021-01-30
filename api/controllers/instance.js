'use strict';

//contrib
const express = require('express');
const router = express.Router();
const winston = require('winston');
const jwt = require('express-jwt');
const async = require('async');
const fs = require('fs');
const jsonwebtoken = require('jsonwebtoken');

//mine
const config = require('../../config');
const logger = winston.createLogger(config.logger.winston);
const db = require('../models');
const common = require('../common');
const events = require('../events');

/**
 * @apiGroup                    Instance
 * @api {get} /instance         Query Instance
 * @apiDescription              Query instances that belongs to a user or member of the group with optional query
 *
 * @apiParam {Object} [find]    Mongo find query JSON.stringify & encodeURIComponent-ed - defaults to {}
 *                              To pass regex, you need to use {$regex: "...."} format instead of js: /.../
 * @apiParam {Object} [sort]    Mongo sort object - defaults to _id. Enter in string format like "-name%20desc"
 * @apiParam {String} [select]  Fields to load - defaults to 'logical_id'. Multiple fields can be entered with %20 as delimiter
 * @apiParam {Number} [limit]   Maximum number of records to return - defaults to 100
 * @apiParam {Number} [skip]    Record offset for pagination (default to 0)
 *
 * @apiHeader {String}          Authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         List of instances (maybe limited / skipped) and total number of instances
 */
router.get('/', jwt({secret: config.amaretti.auth_pubkey}), function(req, res, next) {
    var find = {};
    if(req.query.find || req.query.where) find = JSON.parse(req.query.find || req.query.where);
    if(req.query.limit) req.query.limit = parseInt(req.query.limit);
    if(req.query.skip) req.query.skip = parseInt(req.query.skip);

    //user can only access their own process or process owned by group that they have access to
    let gids = req.user.gids||[];
    find['$or'] = [
        {user_id: req.user.sub},
        {group_id: {$in: req.user.gids||[]}},
    ];

    db.Instance.find(find)
    .select(req.query.select)
    .limit(req.query.limit || 100)
    .skip(req.query.skip || 0)
    .sort(req.query.sort || '_id')
    .exec(function(err, instances) {
        if(err) return next(err);
        /*
        db.Instance.countDocuments(find).exec(function(err, count) {
            if(err) return next(err);
            res.json({instances: instances, count: count});
        });
        */
        res.json({instances: instances});
    });
});

/**
 * @api {put} /instance/:instid Update Instance
 * @apiGroup                    Instance
 * @apiDescription              Update Instance that you own or you are member of the group that instance belongs to
 *
 * @apiParam {String} [name]    Name for this instance
 * @apiParam {String} [desc]    Description for this instance
 * @apiParam {Object} [config]  Configuration for this instance
 *
 * @apiHeader {String} authorization A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}         Instance created
 *
 */
router.put('/:instid', jwt({secret: config.amaretti.auth_pubkey}), function(req, res, next) {
    var id = req.params.instid;

    //can't change these
    delete req.body.user_id;
    delete req.body.create_date;
    delete req.body.group_id; //this could be changed if we updated all task._group_id as well (and revalidate group_id of course)?

    req.body.update_date = new Date();
    db.Instance.findOne({
        _id: id, 
        '$or': [
            {user_id: req.user.sub},
            {group_id: {$in: req.user.gids||[]}},
        ]
    }).exec((err, instance)=>{
        if(err) return next(err);
        if(!instance) return next("no such instance, or no access");

        //let status_changed = false;
        //if(instance.status != req.body.status) status_changed = true;

        //update
        for(let key in req.body) instance[key] = req.body[key];
        instance.save((err, updated_instance)=>{
            if(err) return next(err);
            //instance._status_changed = status_changed;
            res.json(instance);
            events.instance(instance);
        });
    });
});

/**
 * @api {post} /instance        New Instance
 * @apiGroup                    Instance
 * @apiDescription              Create a new instance
 *
 * @apiParam {String} name      Name of the instance
 * @apiParam {Number} [group_id]  Group ID where you want to share this process with (defaults to first gids in jwt)
 * @apiParam {String} [desc]    Description of the instance
 * @apiParam {Object} [config]  Any information you'd like to associate with this instanace
 *
 * @apiHeader {String}          Authorization A valid JWT token "Bearer: xxxxx"
 *
 */
router.post('/', jwt({secret: config.amaretti.auth_pubkey}), function(req, res, next) {
    var instance = new db.Instance({});
    instance.name = req.body.name; //mainly used internally
    instance.desc = req.body.desc;
    instance.config = req.body.config;
    instance.user_id = req.user.sub;

    if(!req.body.group_id) {
        if(req.user.gids.length == 0) return next("group_id is not set and user is not member of any group");
        instance.group_id = req.user.gids[0]; //should be user's first group
    } else {
        //check group_id if user is member of
        let gids = req.user.gids||[];
        if(~gids.indexOf(req.body.group_id)) instance.group_id = req.body.group_id;
        else return next("not member of the group you have specified");
    }

    instance.save(function(err) {
        if(err) return next(err);
        let instance_o = instance.toObject();
        instance_o._status_changed = true; //new object.. so.
        res.json(instance_o);
        events.instance(instance);
    });
});

/**
 * @api {delete} /instance/:instid
 *                              Remove the instance
 * @apiGroup                    Instance
 * @apiDescription              Sets the remove_date to now, so that when the house keeping occurs in the next cycle,
 *                              the task_dir will be removed and status will be set to "removed". If the task is
 *                              running, it will also set the status to "stop_requested" so that it will be
 *                              stopped, then removed.
 *                              Then, it will set config.removing on the instance
  *
 * @apiHeader {String} authorization
 *                              A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccessExample {json} Success-Response:
 *     HTTP/1.1 200 OK
 *     {
 *         "message": "Instance successfully scheduled for removed",
 *     }
 *
 */
router.delete('/:instid', jwt({secret: config.amaretti.auth_pubkey}), function(req, res, next) {
    let instid = req.params.instid;

    //find the instance user wants to update
    db.Instance.findOne({
        _id: instid, 
        '$or': [
            {user_id: req.user.sub},
            {group_id: {$in: req.user.gids||[]}},
        ]
    }, function(err, instance) {
        if(err) return next(err);
        if(!instance) res.status(404).end("no such instance or you don't have access to it");
        
        //request all child tasks to be removed 
        //no need to update if it's already in removed status)
        db.Task.find({instance_id: instid, status: {$ne: "removed"}}, function(err, tasks) {
            async.eachSeries(tasks, function(task, next_task) {
                common.request_task_removal(task, next_task);
            }, function(err) {
                if(err) return next(err);
                
                //set config.removing to true to inform UI that this instance is currently being removed
                db.Instance.findOneAndUpdate({_id: instid}, {$set: {
                    'config.removing': true,
                }}, {new: true}, function(err, instance) {
                    if(err) return next(err);
                    res.json({message: "Instance successfully scheduled -- tasks removed: "+tasks.length});
                    events.instance(instance);
                });
            });
        });
    });
});

//(admin only) count number of instances 
//clients ..
//    warehouse/bin/event_handler/update_prov
//    warehouse/bin/event_handler/update_project_stats
router.get('/count', jwt({secret: config.amaretti.auth_pubkey}), function(req, res, next) {
    if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) return next("admin only");

    var find = {};
    //if(req.query.limit) req.query.limit = parseInt(req.query.limit);
    //if(req.query.skip) req.query.skip = parseInt(req.query.skip);
    if(req.query.find) find = JSON.parse(req.query.find);

    //aggregate task counts
    db.Instance.aggregate([
        {$match: find},
        //{$group: {_id: '$status', count: {$sum: 1}}},

        //sum task counts
        {$group: {_id: '$group_id', 
            requested: {$sum: "$config.counts.requested"},
            running: {$sum: "$config.counts.running"},
            failed: {$sum: "$config.counts.failed"},
            finished: {$sum: "$config.counts.finished"},
            stopped: {$sum: "$config.counts.stopped"},
            removed: {$sum: "$config.counts.removed"},
        }}
    ]).exec(function(err, counts) {
        if(err) return next(err);

        //TODO - should I cure the root cause?
        if(counts == 0) return next("Instance.aggregate didn't return any count");

        delete counts[0]._id; //_id(group id) is not count.. so let's hide it
        res.json(counts);
    });
});

/*
//(admin only) return list of instances currently running 
router.get('/running', jwt({secret: config.amaretti.auth_pubkey}), function(req, res, next) {
    if(!req.user.scopes.amaretti || !~req.user.scopes.amaretti.indexOf("admin")) return next("admin only");

    let find = {
        status: "running",
    };
    if(req.query.find) find = JSON.parse(req.query.find);
    
    //group by status and count
    db.Instance.aggregate([
        {$match: find},
        {$group: {_id: '$service', count: {$sum: 1}}},
    ]).exec(function(err, services) {
        if(err) return next(err);
        res.json(services);
    });
});
*/

module.exports = router;

