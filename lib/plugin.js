const fs = require('fs');
const _ = require('lodash');
const request = require('request');
const http = require('http');
const querystring = require('querystring');
const { ContainershipPlugin, ApiBuilder } = require('@containership/containership.plugin');

const VALID_PROM_QUERY_TYPES = [
    'query',
    'query_range',
    'series'
];

class ContainershipMetricsPlugin extends ContainershipPlugin {

    constructor() {
        super({
            name: 'metrics',
            description: 'A plugin to collect and serve metrics on applications running on ContainerShip.',
            types: ['core']
        });
    };

    addPrometheusServer(host) {
        const applicationName = 'containership-prometheus';
        const api = host.getApi();

        return api.createApplication({
            id: applicationName,
            image: 'containership/prometheus-metric-server:v2',
            cpus: 0.1,
            memory: 320,
            tags: {
                constraints: {
                    max: 1,
                    min: 1
                },
                //host_name: pinned_host.host_name,
                metadata: {
                    plugin: applicationName,
                    ancestry: 'containership.plugin'
                }
            },
            env_vars: {
                PROMETHEUS_STORAGE_LOCAL_TARGET_HEAP_SIZE: 250000000,

                PROMETHEUS_STORAGE_LOCAL_MAX_CHUNKS_TO_PERSIST: 8000,
                PROMETHEUS_STORAGE_LOCAL_NUM_FINGERPRINT_MUTEXES: 5120,
                PROMETHEUS_STORAGE_LOCAL_RETENTION: '168h' // 7 days
            },
            volumes: [
                {
                    host: '/opt/containership/metrics',
                    container: '/opt/containership/metrics'
                }
            ]
        }, (err, res, body) => {
            console.log("Back from createApplication in metrics: " + err + " " + res + " " + JSON.stringify(body));
        });

    }

    addPrometheusAgents(host) {
        const applicationName = 'containership-prometheus-agents';

        const api = host.getApi();

        return api.createApplication({
            id: applicationName,
            image: 'containership/prometheus-metric-targets:v2',
            cpus: 0.1,
            memory: 80,

            tags: {
                constraints: {
                    per_host: '1'
                },
                metadata: {
                    plugin: applicationName,
                    ancestry: 'containership.plugin'
                },
            },

            env_vars: {
                PROMETHEUS_AGENT_CADVISOR: 'true',
                PROMETHEUS_AGENT_NODE_EXPORTER: 'true',
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
        }, (err, result) => {
            console.log("In metrics plugin: " + err + "  " + result);
        });

    }

    startLeader(host) {
        console.log("Adding prometheus agents.");
        this.addPrometheusServer(host);
        this.addPrometheusAgents(host);
    }

    getApiRoutes(host) {
        const api = host.getApi();

        return new ApiBuilder()
            .get('/prometheus/:query_type',
                (req, res) => {
                    return api.getApplications((err, apps) => {
                        if(err) {
                            return console.error(err);
                        }

                        return api.getHosts((err, hosts) => {
                            if(err) {
                                return console.error(err);
                            }

                            const containers = _.get(apps, ['containership-prometheus', 'containers'], []);

                            if(_.isEmpty(containers)) {
                                return res.sendStatus(500);
                            }

                            const prometheusContainer = _.first(containers);
                            const host = prometheusContainer.host;
                            const hostIP = _.get(hosts, [host, 'address', 'private']);
                            const port = 9090;

                            const options = {
                                header: {
                                    Accept: 'application/json'
                                },
                                host: hostIP,
                                port: port,
                                path: `/api/v1/${req.params.query_type}?${querystring.stringify(req.query)}`
                            };

                            console.log('In metrics - requesting ot host: ' + JSON.stringify(options));

                            res.setHeader('Connection', 'Transfer-Encoding');
                            res.setHeader('Content-Type', 'text/html; charset=utf8');
                            res.setHeader('Transfer-Encoding', 'chunked');

                            function cleanup(err) {
                                if(err) {
                                    console.error('ERROR in the containership.metrics plugin: ', err);
                                }

                                res.end();
                                hostReq.destroy();
                            }

                            const hostReq = http.request(options, (hostRes) => {

                                hostRes.on('error', (err) => {
                                    res.send(`${err}`);
                                });

                                hostRes.on('data', (chunk) => {
                                    res.write(chunk);
                                });

                                hostRes.on('end', cleanup);
                            });

                            hostReq.end();
                            hostReq.on('error', cleanup);

                            req.on('close', () => {
                                hostReq.destroy();
                            });

                        });
                    });
                }).value();
    }

}

module.exports = ContainershipMetricsPlugin;
