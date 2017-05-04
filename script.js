var Botkit = require('botkit');
var fs = require('fs');
var request = require("request");
var syncRequest = require('sync-request');
var https = require('https');
const querystring = require('querystring');

var configBotkit = '';
var configMyBot = '';
var optionsAuth = '';
var paramsAuth = '';
var optionsWeather = '';

// Netatmo Weather Station – Getstationsdata
var stationsData = '';

var currentFile = '';
var webServer = '';

// Bot stats
var numberOfMessages = 0;
var today = '';

// Netatmo Authentication
var access_token = '';
var refresh_token = '';
var scope = '';

var roomDeletedByButton = true;
var roomAlreadyCreated = false;

// initialize the configBotkit and configMyBot
fs.readFile('./config/config.json', 'utf8', function(err, data) {
    if (err) {
        return console.log(err);
    }
    data = JSON.parse(data);

    configMyBot = data.mybot;
    configBotkit = data.botkit;
    optionsAuth = data.optionsAuth;
    paramsAuth = querystring.stringify(data.paramsAuth);
    optionsWeather = data.optionsWeather;

    initializeBotkit();
});

function initializeBotkit() {
    var controller = Botkit.sparkbot({
        debug: false,
        log: false,
        public_address: configBotkit.webhookUrl,
        ciscospark_access_token: configBotkit.token,
        secret: "netatmo", // this is an RECOMMENDED but optional setting that enables validation of incoming webhooks
        webhook_name: 'webhookNetatmo',
        // limit_to_domain: ['@cisco.com'],
        // limit_to_org: 'my_cisco_org_id',
    });

    var bot = controller.spawn({});

    controller.setupWebserver(configBotkit.port, function(err, webserver) {
        controller.createWebhookEndpoints(webserver, bot, function() {
            writeLogs("Cisco Spark: Webhooks set up!");
            webServer = webserver;
            initializeGetPostServer();
        });
    });

    controller.middleware.receive.use(function(bot, message, next) {
        writeLogs('"' + message.original_message.personEmail + '" said "' + message.original_message.text + '"');

        var date = new Date();
        date = date.getDate();

        if (message.original_message.personEmail != configMyBot.mail_bot) {
            if (date != today) {
                numberOfMessages = 1;
                today = date;
            } else {
                numberOfMessages += 1;
            }
        }

        next();
    });

    controller.hears(['hello', 'bonjour', 'salut'], 'direct_message,direct_mention', function(bot, message) {
        bot.reply(message, "Salut toi ;)");
    });

    controller.hears('help', 'direct_message,direct_mention', function(bot, message) {
        bot.reply(message, "Je suis le Netatmo-Bot, je sais répondre à trois commandes:" +
            "\n\n- **@netatmo status**: Ce sont les informations du Showroom (Kandinsky & Van Gogh)" +
            "\n\n- **@netatmo battery**: C\'est le niveau de batterie du module Netatmo installé dans la salle Van Gogh" +
            "\n\n- **@netatmo graph**: C'est le graphique sur la journée du taux de CO2 en Kandinsky" +
            "\n\n - **@netatmo stats**: Ce sont des informations sur moi");
    });

    controller.hears('battery', 'direct_message,direct_mention', function(bot, message) {
        try {
            authentication(function() {
                getStationsData(function() {
                    var lvlBatteryVanGogh = stationsData.devices[0].modules[0].battery_percent;
                    bot.reply(message, '**Van Gogh Module Extérieur**, niveau de batterie : ' + lvlBatteryVanGogh + '%');
                });
            });
        } catch (err) {
            writeLogs(err);
        }
    });

    controller.hears('status', 'direct_message,direct_mention', function(bot, message) {
        try {
            authentication(function() {
                getStationsData(function() {
                    var infosKandinsky = stationsData.devices[0].dashboard_data;
                    var infosVanGogh = stationsData.devices[0].modules[0].dashboard_data;

                    bot.reply(message, '**Kandinsky :**\n- Température : ' + infosKandinsky.Temperature +
                        '°C\n- Humidité : ' + infosKandinsky.Humidity + '%\n- Taux de CO2 : ' + infosKandinsky.CO2 +
                        'ppm\n- Nuisance sonore : ' + infosKandinsky.Noise + 'dB\n\n**Van Gogh :**\n- Température : ' + infosVanGogh.Temperature +
                        '°C\n- Humidité : ' + infosVanGogh.Humidity + '%');
                });
            });
        } catch (err) {
            writeLogs(err);
        }
    });

    controller.hears('graph', 'direct_message,direct_mention', function(bot, message) {
        bot.reply(message, 'Je vous envoie le graphique dans un instant ;)');
        var urlImageChart = getMeasureOfTheDay(function(urlImageChart) {
            bot.reply(message, {
                text: 'Voici le graphique de la journée !',
                files: [urlImageChart]
            });
        });
    });

    controller.hears('stats', 'direct_message,direct_mention', function(bot, message) {
        var strMessage = '';
        var strRoom = '';

        request({
            method: 'GET',
            url: configMyBot.api_url + 'rooms',
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'Authorization': 'Bearer ' + configBotkit.token
            }
        }, function(error, response, body) {
            if (response.statusCode == 200) {
                body = JSON.parse(body);
                var botRoomsLength = Object.keys(body.items).length;

                if (botRoomsLength > 1) {
                    strRoom = ' rooms.';
                } else {
                    strRoom = ' room.';
                }

                if (numberOfMessages > 1) {
                    strMessage = ' messages.';
                } else {
                    strMessage = ' message.';
                }

                bot.reply(message, 'Je suis présent dans ' + botRoomsLength + strRoom + '\n\nAujourd\'hui, on m\'a envoyé ' + numberOfMessages + strMessage);
            } else {
                writeLogs(error);
                writeLogs(response.statusCode);
            }
        });
    });

    controller.hears('.*', 'direct_message,direct_mention', function(bot, message) {
        bot.reply(message, "Je vous prie de m'excuser mais je ne comprends pas ce que vous dites." +
            "\n\nUtilisez la commande **_help_** afin de connaître les commandes auxquelles je peux répondre." +
            "\n\nPS: n'oubliez pas de me mentionner si vous êtes dans une room avec plusieurs personnes, comme ceci :\n- @netatmo-bot help");
    });

    setInterval(function() {
        run_script();
    }, configMyBot.time_interval_check_co2);
}

function writeLogs(textLog) {
    var date = new Date();
    dateFinal = date.getDate() + '-' + (date.getMonth() + 1) + '-' + date.getFullYear();

    var hours = date.getHours() + '-' + date.getMinutes() + '-' + date.getSeconds();

    var tmp_path = configMyBot.filepath_log + dateFinal + '.txt';

    if (currentFile == '') {
        currentFile = tmp_path;
    } else if (currentFile != tmp_path) {
        currentFile = tmp_path;
    }

    textLog = hours + ' - ' + textLog + '\n';

    fs.appendFileSync(currentFile, textLog);
}

function initializeGetPostServer() {
    webServer.get('/', function(req, res) {
        var functionAPI = req.query.function;

        request({
            method: 'GET',
            url: configMyBot.api_url + 'rooms',
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'Authorization': 'Bearer ' + configBotkit.token
            }
        }, function(error, response, body) {
            if (response.statusCode == 200) {
                body = JSON.parse(body);

                var rooms = body.items;
                var botRoomsLength = Object.keys(rooms).length;

                var room = '';
                var room_id = '';

                for (var i = 0; i < botRoomsLength; ++i) {
                    room = rooms[i];

                    if (room.title == configMyBot.room_name) {
                        room_id = room.id;
                        writeLogs('room -> ' + room.title);
                        break;
                    }
                }

                if (room_id != '') {
                    callWithButton(room_id, functionAPI);
                    res.sendStatus(200);
                } else {
                    writeLogs('Room not created, we run the script !');
                    run_script_btnPressed();
                    res.sendStatus(200);
                }
            } else {
                writeLogs(error);
                writeLogs(response.statusCode);
            }
        });
    });
}

// function for authenticate from Netatmo API
// this function is called each time botkit hears "battery" or "status"
function authentication(callbackFunction) {
    var callbackAuth = function(response) {
        response.on('error', function(e) {
            writeLogs('error : ' + e);
        });
        var res = '';

        response.on('data', function(chunk) {
            res += chunk;
        });

        response.on('end', function() {
            try {
                res = JSON.parse(res);
                if (response.statusCode == '200') {
                    access_token = res.access_token;
                    refresh_token = res.refresh_token;
                    scope = res.scope;
                    writeLogs("Your access_token is: " + access_token);
                    writeLogs("Your refresh_token is: " + refresh_token);
                    writeLogs("Your scopes are: " + scope);

                    callbackFunction();
                } else {
                    writeLogs('status code:', response.statusCode, '\n', res);
                }
            } catch (err) {
                writeLogs(err);
            }
        });
    };

    var reqAuth = https.request(optionsAuth, callbackAuth);

    reqAuth.on('error', function(e) {
        writeLogs('There is a problem with your request:', e.message);
    });

    reqAuth.write(paramsAuth);
    reqAuth.end();
}

// function for recover the data sent by Netatmo
function getStationsData(callbackFunction) {
    var paramsWeather = querystring.stringify({
        'access_token': access_token
    });

    var callbackWeather = function(response) {
        response.on('error', function(e) {
            writeLogs('error', e);
        });
        var res = '';

        response.on('data', function(chunk) {
            res += chunk;
        });

        response.on('end', function() {
            try {
                res = JSON.parse(res);
                if (response.statusCode == '200') {
                    stationsData = res.body;

                    callbackFunction();
                } else {
                    writeLogs('status code:', response.statusCode, '\n', res);
                }
            } catch (err) {
                writeLogs(err);
            }
        });
    };

    var reqWeather = https.request(optionsWeather, callbackWeather);
    reqWeather.on('error', function(e) {
        writeLogs('There is a problem with your request:', e.message);
    });

    reqWeather.write(paramsWeather);
    reqWeather.end();
}

function run_script() {
    try {
        authentication(function() {
            getStationsData(function() {
                var infosKandinsky = stationsData.devices[0].dashboard_data;
                writeLogs('roomDeletedByButton => ' + roomDeletedByButton);
                if (infosKandinsky.CO2 > configMyBot.seuil_co2) {
                    writeLogs('CO2 -> ' + infosKandinsky['CO2']);
                    if (!roomAlreadyCreated) {
                        if (!roomDeletedByButton) {
                            roomAlreadyCreated = true;
                            alertPeople(infosKandinsky);
                        } else {
                            if (infosKandinsky.CO2 < configMyBot.seuil_co2) {
                                roomDeletedByButton = false;
                            }
                        }
                    }
                } else {
                    roomDeletedByButton = false;
                    if (roomAlreadyCreated) {
                        deleteRoomCO2();
                    }
                    writeLogs('CO2 -> ' + infosKandinsky['CO2']);
                }
            });
        });
    } catch (err) {
        writeLogs(err);
    }
}

function run_script_btnPressed() {
    if (!roomAlreadyCreated) {
        try {
            authentication(function() {
                getStationsData(function() {
                    roomAlreadyCreated = true;
                    var infosKandinsky = stationsData.devices[0].dashboard_data;
                    writeLogs('CO2 -> ' + infosKandinsky['CO2']);
                    alertPeople(infosKandinsky);
                });
            });
        } catch (err) {
            writeLogs(err);
        }
    }
}

function alertPeople(infosKandinsky) {
    request({
        method: 'POST',
        url: configMyBot.api_url + 'rooms',
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'Authorization': 'Bearer ' + configBotkit.token
        },
        form: {
            title: configMyBot.room_name
        }
    }, function(error, response, body) {
        if (response.statusCode == 200) {
            body = JSON.parse(body);
            writeLogs('room -> ' + configMyBot.room_name + ' created !');
            addUsersShowroom(body.id, infosKandinsky);
        } else {
            writeLogs(error);
            writeLogs(response.statusCode);
        }
    });
}

function addUsersShowroom(room_id, infosKandinsky) {
    for (var i = 0; i < configMyBot.usersShowRoom.length; ++i) {
        var res = syncRequest('POST', configMyBot.api_url + 'memberships', {
            'headers': {
                'content-type': 'application/json; charset=utf-8',
                'Authorization': 'Bearer ' + configBotkit.token
            },
            json: {
                roomId: room_id,
                personEmail: configMyBot.usersShowRoom[i]
            }
        });

        if (res.statusCode == 200) {
            writeLogs('membership ok !');
        } else {
            writeLogs('code error : ' + res.statusCode);
            writeLogs(res.headers);
            writeLogs(res.body.toString('utf-8'));
        }
    }

    var message1 = "**Le taux de CO2 relevé dans la salle Kandinsky est anormal. Veuillez prendre les mesures nécessaires:**\n- Taux de CO2 : " + infosKandinsky.CO2;
    var message2 = "Je suis le Netatmo-Bot, je sais répondre à trois commandes:" +
        "\n\n- **@netatmo status**: Ce sont les informations du Showroom (Kandinsky & Van Gogh)" +
        "\n\n- **@netatmo battery**: C\'est le niveau de batterie du module Netatmo installé dans la salle Van Gogh" +
        "\n\n - **@netatmo stats**: Ce sont des informations sur moi";

    var res1 = syncRequest('POST', configMyBot.api_url + 'messages', {
        'headers': {
            'content-type': 'application/json; charset=utf-8',
            'Authorization': 'Bearer ' + configBotkit.token
        },
        json: {
            roomId: room_id,
            markdown: message1,
            files: configMyBot.url_image
        }
    });

    if (res1.statusCode == 200) {
        writeLogs('Message sent: ' + message1);
    } else {
        writeLogs('code error : ' + res1.statusCode);
        writeLogs(res1.headers);
        writeLogs(res1.body.toString('utf-8'));
    }

    var res2 = syncRequest('POST', configMyBot.api_url + 'messages', {
        'headers': {
            'content-type': 'application/json; charset=utf-8',
            'Authorization': 'Bearer ' + configBotkit.token
        },
        json: {
            roomId: room_id,
            markdown: message2
        }
    });

    if (res2.statusCode == 200) {
        writeLogs('Message sent: ' + message2);
    } else {
        writeLogs('code error : ' + res2.statusCode);
        writeLogs(res2.headers);
        writeLogs(res2.body.toString('utf-8'));
    }

    getMeasureOfTheDay(function(urlImageChart) {
        var res3 = syncRequest('POST', configMyBot.api_url + 'messages', {
            'headers': {
                'content-type': 'application/json; charset=utf-8',
                'Authorization': 'Bearer ' + configBotkit.token
            },
            json: {
                roomId: room_id,
                markdown: "Voici le graphique de la journée",
                files: urlImageChart
            }
        });

        if (res3.statusCode == 200) {
            writeLogs('Image sent');
        } else {
            writeLogs('code error : ' + res3.statusCode);
            writeLogs(res3.headers);
            writeLogs(res3.body.toString('utf-8'));
        }
    });
}

function getMeasureOfTheDay(callback) {
    var urlImageChart = '';

    var currentTimeStamp = Math.floor(Date.now() / 1000);

    var midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    var midnightTimeStamp = Math.floor(midnight.getTime() / 1000);

    var urlGetMeasure = configMyBot.netatmo_api_url + "?access_token=" +
        access_token + "&device_id=" + configMyBot.device_id +
        "&scale=max&type=co2&real_time=true&date_begin=" + midnightTimeStamp +
        "&date_end=" + currentTimeStamp;

    try {
        authentication(function() {
            var res = syncRequest('GET', urlGetMeasure);

            if (res.statusCode == 200) {
                urlImageChart = getGraph(res.body.toString('utf-8'));
                if (callback) {
                    callback(urlImageChart);
                }
            } else {
                writeLogs('code error : ' + res.statusCode);
                writeLogs(res.headers);
                writeLogs(res.body.toString('utf-8'));
            }
        });
    } catch (err) {
        writeLogs(err);
    }
}

function getGraph(measures) {
    measures = JSON.parse(measures);
    measures = measures.body;

    var length = Object.keys(measures).length;

    var beginTime = '';
    var valueMeasure = 0;

    var chdValue = 't:';
    var chxlTime = '0:|';

    for (var i = 0; i < length; i += 2) {
        measure = measures[i];
        beginTime = measure.beg_time;
        valueMeasure = measure.value[0];

        chdValue += valueMeasure + ',';
        chxlTime += timeConverter(beginTime) + '|';
    }

    chdValue = chdValue.substr(0, chdValue.length - 1);
    // chdValue += '|';
    //
    // for (var i = 0; i < length; i += 2) {
    //     chdValue += configMyBot.seuil_co2 + ',';
    // }
    //
    // chdValue = chdValue.substr(0, chdValue.length - 1);
    //
    // chdValue += '|2500';

    var urlImageChart = configMyBot.image_chart_url + "cht=lc&chs=999x999&chd=" + chdValue +
        "&chtt=CO2 Day Kandinsky&chds=a&chco=2196F3,FF0000&chxt=x&chxl=" + chxlTime +
        "&chdl=CO2|Threshold&chg=50,50&chls=2|1,6,1&chof=.png";

    urlImageChart = encodeURI(urlImageChart);
    writeLogs(urlImageChart);

    return urlImageChart;
}

function timeConverter(UNIX_timestamp) {
    var a = new Date(UNIX_timestamp * 1000);
    var hour = addZero(a.getHours());
    var min = addZero(a.getMinutes());
    var time = hour + ':' + min;
    return time;
}

function addZero(i) {
    if (i < 10) {
        i = "0" + i;
    }
    return i;
}

function deleteRoomCO2() {
    request({
        method: 'GET',
        url: configMyBot.api_url + 'rooms',
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'Authorization': 'Bearer ' + configBotkit.token
        }
    }, function(error, response, body) {
        if (response.statusCode == 200) {
            body = JSON.parse(body);

            var rooms = body.items;
            var botRoomsLength = Object.keys(rooms).length;

            var room = '';
            var room_id = '';

            for (var i = 0; i < botRoomsLength; ++i) {
                room = rooms[i];

                if (room.title == configMyBot.room_name) {
                    room_id = room.id;
                    writeLogs('room -> ' + room.title);
                    break;
                }
            }

            if (room_id != '') {
                deleteRoom(room_id);
            }
        } else {
            writeLogs(error);
            writeLogs(response.statusCode);
        }
    });
}

function callWithButton(room_id, functionAPI) {
    if (functionAPI == 'call' || functionAPI == 'callend') {
        var url = configMyBot.api_url + 'rooms/' + room_id + '?showSipAddress=true';
        request({
            url: url,
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'Authorization': 'Bearer ' + configBotkit.token
            }
        }, function(error, response, body) {
            if (response.statusCode == 200) {
                body = JSON.parse(body);
                var sipuri = body.sipAddress;
                for (var i = 0; i < configMyBot.endpoints.length; i++) {
                    sendRequest(functionAPI, sipuri, configMyBot.endpoints[i], room_id);
                }
                if (functionAPI == 'callend') {
                    deleteRoom(room_id);
                }
            } else {
                writeLogs(error);
                writeLogs(response.statusCode);
            }
        });
    }
}

function sendRequest(functionAPI, sipuri, endpoint, room_id) {
    var url = configMyBot.php_api_url;

    writeLogs('url: ' + url);
    writeLogs('functionAPI: ' + functionAPI);
    writeLogs('sipuri: ' + sipuri);
    writeLogs('endpoint: ' + endpoint);
    writeLogs('room_id: ' + room_id);

    request.post({
        url: url,
        headers: {
            'content-type': 'application/json; charset=utf-8'
        },
        form: {
            functionAPI: functionAPI,
            sipuri: sipuri,
            endpoint: endpoint
        }
    }, function(error, response, body) {
        if (response.statusCode == 200) {
            writeLogs(body);
        } else {
            writeLogs(error);
            writeLogs(body);
            writeLogs(response.statusCode);
        }
    });
}

function deleteRoom(room_id) {
    request({
        method: 'DELETE',
        url: configMyBot.api_url + 'rooms/' + room_id,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'Authorization': 'Bearer ' + configBotkit.token
        }
    }, function(error, response, body) {
        if (response.statusCode == 204) {
            roomDeletedByButton = true;
            roomAlreadyCreated = false;
            writeLogs('Room removed.');
        } else {
            writeLogs(error);
            writeLogs(response.statusCode);
        }
    });
}
