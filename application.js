'use strict';

const metrics = require('./lib/metrics');

const _ = require('lodash');
const ContainershipPlugin = require('containership.plugin');

module.exports = new ContainershipPlugin({
    type: 'core',

    initialize: function(core){
        const add_prometheus_agents = () => {
            const application_name = 'containership-prometheus-agents';
            core.logger.register(application_name);

            core.cluster.myriad.persistence.get(
                    [core.constants.myriad.APPLICATION_PREFIX, application_name].join(core.constants.myriad.DELIMITER),
                    (err) => {
                        if(err) {
                            return core.applications.add({
                                id: application_name,
                                image: 'containership/docker-cs-prometheus-agents:latest',
                                cpus: 0.1,
                                memory: 64,
                                network_mode: 'host',
                                tags: {
                                    constraints: {
                                        per_host: 1
                                    },
                                    metadata: {
                                        plugin: application_name,
                                        ancestry: 'containership.plugin'
                                    }
                                },
                                env_vars: {
                                },
                                volumes: [
                                    {
                                        host: '/',
                                        container: '/rootfs',
                                        propogation: 'ro'
                                    },
                                    {
                                        host: '/var/run',
                                        container: '/var/run',
                                        propogation: 'rw'
                                    },
                                    {
                                        host: '/sys',
                                        container: '/sys',
                                        propogation: 'ro'
                                    },
                                    {
                                        host: '/var/lib/docker',
                                        container: '/var/lib/docker',
                                        propogation: 'ro'
                                    }
                                ]
                            }, () => {
                                core.loggers[application_name].log('verbose', ['Created ', application_name, '!'].join(''));
                            });
                        }

                        return core.loggers[application_name].log('verbose', [application_name, 'already exists, skipping create!'].join(' '));
                    }
            );
        };

        let server_retry_count = 0;

        const add_prometheus_server = () => {
            const application_name = 'containership-prometheus';
            core.logger.register(application_name);

            const available_hosts = core.cluster.legiond.get_peers();
            available_hosts.push(core.cluster.legiond.get_attributes());
            const follower_hosts = _.filter(available_hosts, (host) => host.mode === 'follower');

            // We cannot add application until we have seen atleast one follower to pin the server to
            // so set exponential backoff (max 60 seconds) until the cluster has connect with a follower
            // and keep attempting to load the server application
            if (follower_hosts.length === 0) {
                let timeout = Math.pow(2, server_retry_count) * 1000 + 5000;
                timeout = timeout < 60000 ? timeout : 60000;
                setTimeout(add_prometheus_server, timeout);
                server_retry_count++;
                return;
            }

            server_retry_count = 0;

            core.cluster.myriad.persistence.get(
                    [core.constants.myriad.APPLICATION_PREFIX, application_name].join(core.constants.myriad.DELIMITER),
                    (err) => {
                        if(err) {
                            return core.applications.add({
                                id: application_name,
                                image: 'containership/docker-cs-prometheus-server:latest',
                                cpus: 0.1,
                                memory: 128, // todo - configure memory based on node size
                                network_mode: 'host',
                                tags: {
                                    // just pick a follower to initially pin the prometheus server to
                                    host: follower_hosts[0].host_name,
                                    /*
                                    constraints: {
                                        // todo - constraints based on cluster size for redundancy
                                    },
                                    */
                                    metadata: {
                                        plugin: application_name,
                                        ancestry: 'containership.plugin'
                                    }
                                },
                                env_vars: {
                                    // based on 128MB image size (128MB (Available memory) / 3 (Prometheus suggestion) / 1024 (chunk size in bytes);
                                    PROM_MEMORY_CHUNKS: 44544
                                },
                                volumes: [
                                    {
                                        host: '/opt/containership/metrics',
                                        container: '/opt/containership/metrics'
                                    }
                                ]
                            }, () => {
                                core.loggers[application_name].log('verbose', ['Created ', application_name, '!'].join(''));

                                core.applications.get_containers(application_name, (err, containers) => {
                                    // need to deploy a container if not already running
                                    if (err || !containers || 0 === containers.length) {
                                        core.applications.deploy_container(application_name, {}, (err) => {
                                            if (err) {
                                                // TODO - check if it is because the host constraint is no longer valid and update to a new host
                                                return core.loggers[application_name].log('error', `${application_name} failed to deploy: ${err.message}`);
                                            }

                                            return core.loggers[application_name].log('verbose', `${application_name} container deploy`);
                                        })
                                    }
                                });

                            });
                        }

                        return core.applications.get_containers(application_name, (err, containers) => {
                            // need to deploy a container if not already running
                            if (err || !containers || 0 === containers.length) {
                                core.applications.deploy_container(application_name, {}, (err) => {
                                    if (err) {
                                        // TODO - check if it is because the host constraint is no longer valid and update to a new host
                                        return core.loggers[application_name].log('error', `${application_name} failed to deploy: ${err.message}`);
                                    }

                                    return core.loggers[application_name].log('verbose', `${application_name} container deploy`);
                                })
                            }
                        });
                    }
            );
        };

        if('leader' === core.options.mode) {
            if(core.cluster.praetor.is_controlling_leader()) {
                add_prometheus_server();
                add_prometheus_agents();
            }

            core.cluster.legiond.on('promoted', () => {
                core.cluster.myriad.persistence.keys(core.constants.myriad.APPLICATIONS, (err, applications) => {
                    if(err || !_.isEmpty(applications)) {
                        add_prometheus_server();
                        add_prometheus_agents();
                        return;
                    }

                    return setTimeout(() => {
                        add_prometheus_server();
                        add_prometheus_agents();
                    }, 2000);
                });
            });

            return metrics.Init(core).register_routes();
        }
    },

    reload: function() {}
});
